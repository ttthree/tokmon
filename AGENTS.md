# tokmon — Data Source Architecture

## Workflow for Coding Agents

After making any code changes, you MUST:

1. Run `npm run build` to produce a fresh `dist/` (both the CLI in `dist/src/` and the web bundle).
2. Run `npm link` from the repo root so the global `tokmon` command points at the freshly built CLI.

This ensures the user's globally installed `tokmon` reflects your edits. Do this before declaring work complete, and re-run after every subsequent code change — the built output is not updated automatically.

```bash
npm run build && npm link
```

If tests are relevant to the change, also run `npm run test:unit` before the build/link step.

## Overview

tokmon collects token usage and cost data from multiple AI coding agents. Each agent stores session data in different formats and locations. This document describes the data flow, parsing rules, and critical constraints.

## Data Sources

### 1. Claude Code (`source: "claude-code"`)

**Parser:** `src/parsers/claude-code.ts`

**Scans:**
- `~/.claude/projects/{encoded_cwd}/*.jsonl` — direct CLI sessions
- `~/.craft-agent/.claude/projects/{encoded_cwd}/*.jsonl` — unclaimed Eureka sub-agent sessions (see Eureka section)

**Path encoding:** Both `/` and `.` in the cwd are replaced with `-`. Example:
```
/Users/jietong/.craft-agent/workspaces/9df32373.../workdirectory
→ -Users-jietong--craft-agent-workspaces-9df32373...-workdirectory
```

**Data format:** Each `.jsonl` file is a Claude Code session. Each line with `type: "assistant"` is one API interaction containing:
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "model": "claude-opus-4.6-1m",
    "usage": {
      "input_tokens": 38097,
      "output_tokens": 379,
      "cache_read_input_tokens": 32024,
      "cache_creation_input_tokens": 0
    }
  }
}
```

**Token extraction rules:**
- Tokens and model MUST be read from each individual `assistant` line's `message.usage` and `message.model`
- A single session can use multiple models (e.g., haiku for fast tasks, opus for complex ones)
- `modelUsage` is built per-model from these per-line values
- For large files (>5MB), only head+tail are read; usage is extracted via balanced-brace regex, not full JSON.parse
- Sub-agent files in `{sessionId}/subagents/*.jsonl` are also scanned

**Claimed file exclusion:** Files in `~/.craft-agent/.claude/` that match an Eureka session's `sdkSessionId` are skipped (they are "claimed" by the Eureka parser). Unclaimed files are treated as `source: "claude-code"`.

### 2. Eureka (`source: "eureka"`)

**Parser:** `src/parsers/eureka.ts`

**Scans:** `~/.craft-agent/workspaces/*/sessions/*/`

**Session header:** First line of `session.jsonl` contains metadata:
- `id` — Eureka session ID (e.g., `260412-lively-spray`)
- `engine` — `claude` or `codex`
- `sdkSessionId` — UUID linking to the underlying Claude Code or Codex session
- `sdkCwd` — working directory used by the SDK session
- `tokenUsage` — aggregated totals (DO NOT USE for token data — see constraints)
- `costUsd` — Eureka's calculated cost (DO NOT USE — see constraints)
- `name`, `workingDirectory`, `messageCount`, `userMessageCount` — metadata

**Token data source depends on `sdkSessionId`:**

| Has `sdkSessionId`? | Engine | Token source | Cost source |
|---|---|---|---|
| Yes | claude | CC `.jsonl` file at `~/.craft-agent/.claude/projects/{encoded_sdkCwd}/{sdkSessionId}.jsonl` + sub-agents | Calculated from tokens × pricing |
| Yes | codex | Codex session file at `{sessionPath}/.codex-home/sessions/*-{sdkSessionId}.jsonl` → `total_token_usage` | Calculated from tokens × pricing |
| No | any | No tokens (0) — CC parser handles the unclaimed files as `source: "claude-code"` | No cost (0) |

**Eureka MUST run before Claude Code parser** so that `claimedCcSessionIds` is populated before the CC parser scans `~/.craft-agent/.claude/`.

### 3. Codex (`source: "codex"`)

**Parser:** `src/parsers/codex.ts`

**Scans:**
- `~/.codex/state_N.sqlite` — thread metadata (id, cwd, title, timestamps)
- `~/.codex/sessions/YYYY/MM/DD/rollout-*-{threadId}.jsonl` — detailed session data

**Token data from session files:** The `total_token_usage` event (read from the last 8KB of the file):
```json
{
  "input_tokens": 29576,
  "cached_input_tokens": 13952,
  "output_tokens": 324,
  "reasoning_output_tokens": 135,
  "total_tokens": 29900
}
```

**Mapping:** `input = input_tokens - cached_input_tokens`, `cacheRead = cached_input_tokens`, `output = output_tokens`

**Note:** `threads.tokens_used` in SQLite is a cumulative total with no input/output split. DO NOT use it for token breakdown.

### 4. Copilot CLI (`source: "copilot-cli"`)

**Parser:** `src/parsers/copilot-cli.ts`

**Scans:** `~/.copilot/logs/process-*.log`

Parses structured log events for `assistant_usage` and `cli.model_call` entries.

## Critical Constraints

### DO NOT use `tokenUsage` from Eureka session headers for token data

The `tokenUsage` field in Eureka's `session.jsonl` header has multiple problems:
- **Old sessions (pre-March 2026):** `inputTokens` is 0, only `outputTokens` and `costUsd` are populated
- **Even when populated:** The values are aggregate totals that cannot be attributed to specific models
- **Per-model breakdown is impossible** from header data

Always read tokens from the underlying CC/Codex session files via `sdkSessionId`.

### DO NOT use `costUsd` from any header or telemetry

All cost MUST be calculated uniformly from `tokens × pricing` during the enrichment step (`enrichSession` in `collect.ts`). This ensures:
- Consistent pricing across all sources
- Correct per-model cost attribution
- No discrepancy between different cost calculation methods

The `costUsd` field in Eureka headers uses Eureka's own pricing which may differ from tokmon's pricing data (sourced from LiteLLM).

### DO NOT use `llm-telemetry.jsonl` for token or model data

Eureka's telemetry has critical gaps:
- **Anthropic provider:** `inputTokens`, `outputTokens`, `cacheReadTokens` are ALL null/0 (7,914 entries, 0% with data)
- **Codex provider:** `inputTokens` is INCLUSIVE of cache (not the same convention as CC files)
- **All providers:** `costUsd` is always 0
- **Model names from telemetry** should not be used — they get joined into strings like `"claude, claude-haiku-4-5-20251001, claude-opus-4-6-1m"`

The telemetry is only used for: timestamps, turn tracking, duration, and provider identification.

### Model data MUST come from per-request level

Each API interaction line in CC `.jsonl` files has its own `message.model`. A single session may use multiple models. The `modelUsage` field on `Session` tracks per-model token breakdown:

```typescript
interface Session {
  model: string;          // Primary model (first seen), for display only
  modelUsage?: Record<string, TokenBreakdown>;  // Per-model token breakdown from individual API calls
}
```

The dashboard's "Cost by Model" chart distributes session cost proportionally across models based on `modelUsage` token counts.

### `inputTokens` semantics differ by source

| Source | `inputTokens` meaning | How to get net input |
|---|---|---|
| CC `.jsonl` `usage.input_tokens` | Net new input (EXCLUDES cache) | Use as-is |
| Codex `total_token_usage.input_tokens` | Total input (INCLUDES cached) | Subtract `cached_input_tokens` |
| Eureka telemetry `inputTokens` (codex provider) | Total input (INCLUDES cache) | Subtract `cacheReadTokens` |
| Eureka header `tokenUsage.inputTokens` | Total input (INCLUDES cache) | DO NOT USE |

### Usage extraction for large files

CC `.jsonl` files can be 200MB+. The parser:
1. Files ≤5MB: `readFile` + `split` + line-by-line processing
2. Files >5MB: Read first 256KB + last 64KB only
3. Usage is extracted via balanced-brace matching (not regex `[^}]` which breaks on nested `cache_creation: {...}` objects)
4. Every 200 files, yield to event loop (`setTimeout(0)`) to allow GC

### Parser execution order

```
1. Eureka parser    → populates claimedCcSessionIds
2. Claude Code parser → excludes claimed IDs from .craft-agent/.claude/
3. Codex parser
4. Copilot CLI parser
```

This order is enforced in `src/parsers/index.ts`.

### No double counting

| Combination | Prevention mechanism |
|---|---|
| Eureka ↔ CC (same file) | `claimedCcSessionIds` set: Eureka claims files by `sdkSessionId`, CC parser skips them |
| Eureka ↔ Codex (same thread) | Eureka reads from `.codex-home/` per-session SQLite, not from `~/.codex/` global SQLite |
| Old Eureka (no sdkSessionId) ↔ CC | Eureka outputs 0 tokens/cost; CC parser picks up unclaimed files as `source: "claude-code"` |

## Cost Calculation

All cost is calculated in `enrichSession()` (`src/cli/commands/collect.ts`):

```
cost = calculateSessionCost(date, tokens, model, source)
     = lookupPricing(pricingData, model, source)  // from LiteLLM pricing DB
     → calculateCost(tokens, pricing)              // tokens × $/M rates
```

No parser should set `cost.total > 0`. Cost is always 0 from parsers and calculated during enrichment.

## Memory Considerations

- Total CC files: ~4,200 across both directories (~1.7GB)
- Peak memory during parsing: ~1.1GB (V8 GC is not aggressive enough in tight async loops)
- CLI uses `#!/usr/bin/env -S node --max-old-space-size=8192` to accommodate this
- Large files use head+tail reading to avoid allocating multi-MB strings
