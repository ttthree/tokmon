# DESIGN: Mars Orchestrator Tagging & Grouping (v2)

## Motivation

`tokmon` already treats Eureka as a first-class "orchestrator" that wraps sub-agents. The `eureka` parser claims CC sessions by `sdkSessionId` so orchestrator attribution takes precedence over raw sub-agent source.

**Mars (MarsIWE)** is architecturally analogous: it spawns Claude Code / Codex / Copilot CLI as child processes and tracks the mapping in its own SQLite DB. Each Mars session has `task_id`, `workspace_id`, `agent_type`, and `agent_session_id` (the sub-agent's session UUID).

**However**, diagnostic investigation (see "Diagnostic Findings" below) reveals that Mars runs **every** sub-agent against isolated config directories under its app-support folder, *not* against `~/.claude`, `~/.codex`, or `~/.copilot`. This means:

1. **Mars sessions are currently 100% invisible to tokmon** — they don't appear at all today, not just as mis-attributed "plain" CC/Codex sessions.
2. The "claim by session id" pattern from Eureka does not apply directly. Instead, we need to *scan* Mars's isolated directories with the existing parser logic and *enrich* the resulting sessions with orchestrator metadata from Mars's own SQLite DB.
3. There is therefore no conflict with Eureka claims, and no precedence ambiguity: Mars sessions live in different files on disk.

## Diagnostic Findings (Pre-implementation)

Done against the user's real data (~254 Mars sessions):

| Sub-agent | Mars location | Matches `~/.<agent>/`? |
|-----------|---------------|------------------------|
| Claude Code | `<app>/agent-configs/claude/projects/<project-path>/<sessionId>.jsonl` | **No** — session IDs don't appear in `~/.claude/projects/` |
| Codex | `<app>/agent-configs/codex/state_5.sqlite` + `<app>/agent-configs/codex/sessions/` | **No** — thread IDs don't appear in `~/.codex/state_*.sqlite` |
| Copilot CLI | `<app>/agent-configs/copilot/logs/process-*.log` (empty today) | **No** — independent `--config-dir` passed at launch |

Where `<app>` = `~/Library/Application Support/com.marsiwe.app` (and its dev sibling `com.marsiwe.app.dev`).

The isolation is implemented in `MarsIWE/src-tauri/src/agent_config_dir.rs` via `IsolatedAgent::{ClaudeCode, Codex, CopilotCli}` → separate `agent-configs/{claude,codex,copilot}` directories, with `--config-dir` or `CLAUDE_CONFIG_DIR` / env overrides.

**Implication for this design**: The parsers must support **multiple source roots**. Existing code already does this for Claude Code (scans both `~/.claude` and `~/.craft-agent/.claude`), so the pattern is proven.

**Copilot session ID alignment**: The `sessions.agent_session_id` that Mars stores for copilot sessions is a UUID (e.g. `f38de33b-7df6-4e42-911b-27e55d967629`). The existing `copilot-cli` parser derives a session key by fallback chain `session_id → interaction_id → copilot_pid → api_id` (see `src/parsers/copilot-cli.ts:283`). Whether Mars's `agent_session_id` matches any of these cannot be verified on this machine today (the isolated Copilot dir is empty). **Plan**: Implement Copilot Mars attribution with a best-effort match on all four keys and log unmatched sessions at debug level for future diagnosis. No Copilot data will be lost (sessions still parsed, just without orchestrator tag if key doesn't match).

---

## Non-Goals

- No changes to Mars itself. Read-only access to its SQLite DB and isolated config directories.
- Mars is not a new token source — tokens come from the standard jsonl / sqlite artifacts in Mars's isolated dirs.
- No session-message-level detail from Mars's own DB beyond the task/workspace/session join.

---

## Architecture

### Three Layers

1. **Discovery** (`src/core/config.ts`): Expose Mars's isolated agent directory paths.
2. **Scanning** (extension of existing parsers): Each of `claude-code.ts`, `codex.ts`, `copilot-cli.ts` gains an optional "extra root" (Mars's dir) to scan alongside its default roots.
3. **Tagging** (`src/parsers/mars.ts`): Load Mars SQLite → build a `Map<agentSessionId → MarsSessionMeta>` → re-keyed per agent type. Consumed by the three sub-agent parsers after they produce raw Sessions.

### Data Flow

```
                 ┌────────────────────────────────────┐
                 │ mars.ts (runs first)                │
                 │ - locate marsiwe.db (+ dev)         │
                 │ - join sessions × tasks × workspaces│
                 │ - populate marsMetaByAgentSessionId │
                 │ - expose mars isolated dir paths    │
                 └────────┬───────────────────────────┘
                          │ (module-level maps)
         ┌────────────────┼──────────────────┬──────────────────┐
         ▼                ▼                  ▼                  │
┌─────────────────┐ ┌──────────────┐ ┌──────────────────┐       │
│ claude-code.ts  │ │ codex.ts     │ │ copilot-cli.ts   │       │
│ scans:          │ │ scans:       │ │ scans:           │       │
│  ~/.claude      │ │ ~/.codex     │ │ ~/.copilot       │       │
│  ~/.craft-agent │ │ mars codex   │ │ mars copilot     │       │
│  mars claude    │ │              │ │                  │       │
│ each session →  │ │              │ │                  │       │
│  check marsMeta │ │ check marsMeta│ │ check marsMeta  │       │
│  → apply tag    │ │ → apply tag  │ │ → apply tag      │       │
└─────────────────┘ └──────────────┘ └──────────────────┘       │
         │                │                  │                  │
         └────────────────┴──────────────────┴──────────────────┘
                                  │
                                  ▼
                           Session[] with orchestrator
```

### Parser Ordering (Unchanged + Mars First)

```ts
// src/parsers/index.ts
export const parsers: Parser[] = [marsParser, eurekaParser, claudeCodeParser, codexParser, copilotCliParser];
```

`marsParser` runs first solely to populate module-level metadata maps and to expose Mars's extra config roots. It emits **zero** Sessions.

`eurekaParser` runs next (unchanged). Because Mars and Eureka operate on completely different file paths, there is no claim conflict — but we preserve the documented order for determinism.

The three sub-agent parsers then run. **No change to Eureka's existing claim behaviour.** Mars tagging is applied *after* a session is already produced and *after* Eureka claim filtering — so Eureka wins by construction if the (hypothetical, never-observed) case occurred.

### Mars Parser Responsibilities

```ts
// src/parsers/mars.ts

export interface MarsSessionMeta {
  marsSessionId: string;       // from sessions.id (hex UUID)
  agentSessionId: string;      // from sessions.agent_session_id (used as key)
  agentType: "claude-code" | "codex" | "copilot-cli";
  sessionName?: string;        // from sessions.name (e.g. "coder", "reviewer")
  phaseOrder: number;          // from sessions.phase_order
  isBackground: boolean;       // from sessions.is_background
  taskId?: string;             // from tasks.id (hex)
  taskTitle?: string;          // from tasks.title
  taskStatus?: string;         // from tasks.status
  workspaceId?: string;        // from workspaces.id (hex)
  workspaceName?: string;      // from workspaces.name
  workspacePath?: string;      // from workspaces.path
}

export interface MarsRegistry {
  /** All Mars agent-config roots that exist on disk. Multiple if both stable + dev present. */
  claudeRoots: string[];   // each points to a directory that looks like ~/.claude
  codexRoots: string[];    // each points to a directory that looks like ~/.codex
  copilotRoots: string[];  // each points to a directory that looks like ~/.copilot
  byAgentSessionId: {
    claudeCode: Map<string, MarsSessionMeta>;
    codex: Map<string, MarsSessionMeta>;
    copilotCli: Map<string, MarsSessionMeta>;
  };
}

/**
 * Populated by marsParser.parse(). MUST be cleared at the start of each parse pass
 * to avoid stale entries when collect is called repeatedly in one process (e.g. the server).
 */
export let marsRegistry: MarsRegistry;

export function resetMarsRegistry(): void { /* clears all maps + arrays */ }

export const marsParser: Parser = {
  source: "mars",
  async parse(ctx): Promise<ParseResult> {
    resetMarsRegistry();
    // 1. discover app-support dirs (stable + dev)
    // 2. for each, add agent-configs/{claude,codex,copilot} to registry.*Roots (if dir exists)
    // 3. read marsiwe.db (and dev's), execute join query
    // 4. populate byAgentSessionId maps
    return { sessions: [], cursorUpdates: {} };
  },
};
```

### Sub-agent Parser Integration

Each of the three parsers already takes a list of directories to scan. Minimal change — add Mars roots to that list:

```ts
// claude-code.ts
import { marsRegistry } from "./mars.js";

const directories: Array<{ dir: string; excludeClaimed: boolean }> = [
  { dir: getClaudeDirectory(), excludeClaimed: false },
  { dir: getCraftAgentClaudeDirectory(), excludeClaimed: true },
  ...marsRegistry.claudeRoots.map(dir => ({ dir, excludeClaimed: false })),
];

// After building each Session:
const marsMeta = marsRegistry.byAgentSessionId.claudeCode.get(sessionId);
if (marsMeta) {
  session = applyMarsMeta(session, marsMeta, "claude-code");
}
```

Same pattern for `codex.ts` (add `marsRegistry.codexRoots` to the state-db search) and `copilot-cli.ts` (add `marsRegistry.copilotRoots/logs/process-*.log` glob).

**For Codex** specifically: the existing parser does `findStateDatabase(codexDir)` then `buildRolloutStatsMap(codexDir, ...)`. We extend it to accept `roots: string[]` and union results across all roots.

**For Copilot** specifically: its session key derivation already uses a fallback chain. We try **all four** fallback keys against the Mars meta map before concluding no match.

### `applyMarsMeta`

```ts
function applyMarsMeta(session: Session, meta: MarsSessionMeta, subAgent: "claude-code" | "codex" | "copilot-cli"): Session {
  return {
    ...session,
    engine: engineLabel(subAgent),   // "Mars + CC" / "Mars + Codex" / "Mars + Copilot CLI"
    // project/projectPath: prefer Mars workspace path if present (more canonical)
    projectPath: meta.workspacePath ?? session.projectPath,
    project: meta.workspacePath ? normalizeProjectName(meta.workspacePath) : session.project,
    orchestrator: {
      kind: "mars",
      taskId: meta.taskId,
      taskTitle: meta.taskTitle,
      taskStatus: meta.taskStatus,
      sessionName: meta.sessionName,
      marsSessionId: meta.marsSessionId,
    },
  };
}
```

### Session Type Change

```ts
// src/core/types.ts

export type OrchestratorKind = "mars" | "eureka";

export interface OrchestratorInfo {
  kind: OrchestratorKind;
  /** Human-readable label for orchestrator task — REQUIRED when taskId present */
  taskTitle?: string;
  taskId?: string;
  taskStatus?: string;          // Mars only
  /** Label for this session within the orchestrator task (e.g. "coder", "reviewer") */
  sessionName?: string;
  /** Mars-specific session UUID. Required when kind==="mars". */
  marsSessionId?: string;
}

export interface Session {
  // ... existing fields
  orchestrator?: OrchestratorInfo;
}
```

**Invariants** (enforced at construction, asserted in tests):
- If `kind === "mars"`, `marsSessionId` is defined.
- If `taskId` is defined, `taskTitle` is also defined (or both undefined).
- `kind` alone (with everything else undefined) is valid (represents "orchestrator identity is known but details stripped by privacy").

---

## Module-Level State Lifecycle

The existing Eureka parser has a subtle issue: `claimedCcSessionIds` is module-level and never cleared. In long-running processes (the dashboard server) this slowly accretes stale IDs. This is pre-existing and not caused by this design, but because we're introducing more module-level maps, we fix it as a small side-improvement.

**Rule for all orchestrator parsers**: Call a `reset*()` function at the **start** of `parse()`. This ensures each `collect` pass starts with an empty claim/meta state, then repopulates from fresh data.

- `eurekaParser.parse()` → call `claimedCcSessionIds.clear()` at top
- `marsParser.parse()` → call `resetMarsRegistry()` at top

This is a bugfix with user-visible benefit: re-running `collect` in the same process no longer risks stale claims.

---

## Incremental Updates

Mars DB is small (~254 rows today, likely to stay under 10k for foreseeable use). **Full scan on every `collect` is acceptable**. No cursor needed.

The scanned jsonl/sqlite files from Mars's isolated dirs *do* benefit from the existing per-file cursor system, which works unchanged (the cursor key is the absolute file path).

---

## Privacy

Add to `PrivacyConfig.sync`:

```ts
includeOrchestratorMetadata: boolean;   // default: true
```

`redactSessionForSync()` additions:

```ts
if (!config.sync.includeOrchestratorMetadata && session.orchestrator) {
  session.orchestrator = { kind: session.orchestrator.kind };
  // Keep only the kind; strip task titles, session names, IDs.
}
```

Rationale: `kind` is a privacy-safe flag ("this session was orchestrated by Mars") while task titles and session names may be user-authored and sensitive. IDs (taskId, marsSessionId) are machine-local UUIDs — not sensitive, but also useless to other machines, so redacting them is safe.

---

## CLI Changes

```
tkroi stats --orchestrator <mars|eureka|none>
tkroi stats --by mars-task                 # aggregate by orchestrator.taskTitle (Mars only)
```

Existing flags untouched.

---

## Dashboard Changes

- New filter pill: **Orchestrator**: `All | Mars | Eureka | None`. Orthogonal to existing Source filter.
- New aggregation option in Cost-by-X cards: "By Mars Task" (enabled when any Mars-orchestrated sessions present).
- Session detail modal: new "Orchestrator" row when `orchestrator` is set, rendered as `Mars · Implement Sidecar Audit Pull · reviewer (in_progress)`.

---

## Test Strategy

### Unit Tests

**`tests/parsers/mars.test.ts`** — pure mars parser behaviour:
- Fixture: temp directory with handcrafted `marsiwe.db` (created via `better-sqlite3` in test setup) and stub agent-configs subdirs.
- Assertions:
  - Empty DB file → empty registry, no throw.
  - Missing DB file → empty registry, no throw.
  - Normalize `agent_type` variants (`claude-code`, `claude_code`, `codex-cli`, etc.) correctly bucket by agent kind.
  - Unknown `agent_type` → skipped silently (logged at debug).
  - `sessions` rows with NULL `agent_session_id` → skipped.
  - Orphan sessions (NULL `task_id`) → meta still populated, `taskTitle === undefined`.
  - Both stable + dev DBs present → both merged; if same `agent_session_id` in both, later `updated_at` wins.
  - Roots arrays only include dirs that actually exist on disk.
- Claim-map reset:
  - Call `parse()` twice with different DB contents → second call's registry does not contain entries from the first.

**`tests/parsers/mars-claude-integration.test.ts`**:
- Fixture: Mars SQLite + a matching `<marsClaudeRoot>/projects/-path-/SESSION_ID.jsonl` with valid Claude Code entries.
- Assertion: resulting Session has `orchestrator.kind === "mars"`, `engine === "Mars + CC"`, `projectPath === workspacePath`, token totals match jsonl content.
- Negative: a `.jsonl` with a session ID **not** in Mars DB yields a Session with `orchestrator === undefined` (still collected, just untagged).

**`tests/parsers/mars-codex-integration.test.ts`**:
- Fixture: Mars SQLite + Mars-isolated codex `state_5.sqlite` with matching thread IDs + rollout jsonl files under `sessions/`.
- Assertion: resulting Session has `orchestrator.kind === "mars"`, `engine === "Mars + Codex"`, token totals match codex data.

**`tests/parsers/mars-copilot-integration.test.ts`**:
- Fixture: Mars SQLite + Mars-isolated `logs/process-*.log` with telemetry entries.
- Variants:
  - Mars `agent_session_id` matches raw `session_id` in telemetry → tagged.
  - Matches `interaction_id` only → tagged (fallback key).
  - No match → Session present but untagged.
- Assertion: log-level debug message emitted on no-match (captured via test spy).

**`tests/core/privacy.test.ts`** (extended):
- `redactSessionForSync` with `includeOrchestratorMetadata: false` strips all orchestrator fields except `kind`.
- With `true`, no changes.

**`tests/core/aggregate.test.ts`** (extended):
- `--by mars-task` groups sessions by `orchestrator.taskTitle` for Mars-orchestrated sessions and by `__untagged__` for the rest.
- `--orchestrator mars` filter keeps only Mars-orchestrated sessions.

### End-to-End Tests

**`tests/e2e/mars-e2e.test.ts`**:
- Setup: pre-built fixtures under `tests/fixtures/mars-e2e/` with:
  - `app-support/com.marsiwe.app/marsiwe.db` (2 tasks, 4 sessions: 2 CC, 1 Codex, 1 Copilot)
  - Matching jsonl/sqlite artifacts in the isolated agent-configs dirs
- Execution: `HOME=<fixture-home> tkroi collect` → `tkroi stats --orchestrator mars`
- Assertions:
  - Exit 0
  - Stats output includes exactly 4 sessions
  - Cost-by-task groups sum correctly
  - Running `collect` twice does not double-count

**Dashboard Playwright** (extended in existing `dashboard.spec.ts`):
- After loading fixture data, Orchestrator filter pill is visible and functional; clicking "Mars" reduces the session list to Mars-orchestrated only.

### Diagnostic Safety Net

Before first real use against the user's actual Mars install, the implementation logs (at INFO level, once per `collect`) a summary:

```
[mars] Found marsiwe.db with 254 sessions (5 workspaces, 38 tasks).
[mars] Matched agent-configs roots: claude=1, codex=1, copilot=1.
[mars] Per-agent claim potential: claude-code=120, codex=87, copilot-cli=47.
[mars] Actually tagged after scan: claude-code=119, codex=87, copilot-cli=12.
```

If the "potential" and "actually tagged" numbers diverge substantially for any agent, this is surfaced to the user as an informational message (not error), suggesting a bug report. This addresses the coder's concern about silent ID misalignment for Codex/Copilot by making it visible.

---

## Implementation Order

1. **`src/core/types.ts`** — add `OrchestratorInfo`, optional `Session.orchestrator` field. No behaviour change.
2. **`src/parsers/mars.ts`** — Mars DB discovery + registry + reset. Emits zero sessions. Unit-tested in isolation.
3. **Wire `marsParser` first** in `src/parsers/index.ts`.
4. **Fix Eureka reset bug** in `src/parsers/eureka.ts` (call `claimedCcSessionIds.clear()` at start of `parse()`).
5. **Extend `claude-code.ts`** to accept extra Mars roots + tag with Mars meta.
6. **Extend `codex.ts`** likewise.
7. **Extend `copilot-cli.ts`** likewise (with four-key fallback match + debug log on no-match).
8. **Populate `Eureka.orchestrator`** field (free bonus — currently only stored in `engine` string).
9. **Privacy**: `includeOrchestratorMetadata` config + redaction.
10. **Aggregate**: `by: "mars-task"`, `orchestrator` filter.
11. **CLI flags**: `--orchestrator`, `--by mars-task`.
12. **Dashboard**: Orchestrator filter pill, aggregation card, session detail row.
13. **Diagnostic summary log** in `collect` output.
14. **E2E fixture build + test.**

Each step has unit tests. Tests pass at each checkpoint.

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `OrchestratorInfo` + optional `orchestrator` field |
| `src/parsers/mars.ts` | **NEW** — DB discovery, registry, reset |
| `src/parsers/index.ts` | Prepend `marsParser` |
| `src/parsers/eureka.ts` | Clear `claimedCcSessionIds` at start; populate `orchestrator: {kind:"eureka"}` |
| `src/parsers/claude-code.ts` | Accept extra roots; apply Mars meta |
| `src/parsers/codex.ts` | Accept extra roots; apply Mars meta |
| `src/parsers/copilot-cli.ts` | Accept extra roots; four-key fallback match; debug log unmatched |
| `src/core/privacy.ts` | `includeOrchestratorMetadata` + redaction |
| `src/core/aggregate.ts` | `--by mars-task`, `orchestrator` filter |
| `src/cli/**` | New flags |
| `src/web/**` | Orchestrator filter + detail row |
| `tests/parsers/mars.test.ts` | **NEW** |
| `tests/parsers/mars-claude-integration.test.ts` | **NEW** |
| `tests/parsers/mars-codex-integration.test.ts` | **NEW** |
| `tests/parsers/mars-copilot-integration.test.ts` | **NEW** |
| `tests/e2e/mars-e2e.test.ts` | **NEW** |
| `tests/core/{privacy,aggregate}.test.ts` | Extended |

---

## Resolved Concerns (from Round 1 Review)

| # | Concern | Resolution |
|---|---------|------------|
| 1 | Parser precedence contradictory (Mars first vs Eureka wins) | Mars and Eureka operate on disjoint files → no real conflict. Documented clearly above. |
| 2 | Codex/Copilot ID alignment unverified | Diagnostic done: Mars runs against isolated configs, so Mars's own sqlite/jsonl files contain the same IDs. Copilot's best-effort 4-key fallback + visible diagnostic log handles residual uncertainty. |
| 3 | Claim-map lifecycle unspecified | `reset*()` at start of every `parse()`. Also fixes existing Eureka bug. |
| 4 | `orchestrator` inner invariants | Documented per-kind required fields. |
| 5 | Privacy redaction scope | `includeOrchestratorMetadata: true` default. When false, keeps only `kind`. |
| 6 | Test plan gaps | Added: precedence tests, reset-across-runs tests, diagnostic match-rate log. |
