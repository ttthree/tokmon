# Design: Token Accuracy Fixes for Eureka & Claude Code Parsers

**Author:** Architect (Eureka)
**Date:** 2026-04-18
**Status:** Draft v3 (incorporates coder review rounds 1 & 2)
**Working dir:** `/Users/jietong/work/tokmon`

---

## 1. Background

While auditing tokmon's data collection pipeline against real sessions, we found four classes of bugs that produce wrong token totals:

| # | Bug | Symptom | Source |
|---|-----|---------|--------|
| **B1** | CC large-file truncation | For `session.jsonl` > 5 MB, `parseClaudeSessionFile` reads only head 256 KB + tail 64 KB. Empirically captures 0.7-7.1 % of tokens. | `src/parsers/claude-code.ts` |
| **B2** | Eureka large-file truncation | Same head+tail approach in `readFileWithSizeLimit`. Drops tokens for any large CC `.jsonl` opened via Eureka's SDK fallback. | `src/parsers/eureka.ts:552-572` |
| **B3** | Wrong copilot_sdk fallback path | `readCodexSessionTokens` only probes `<sessionPath>/.codex-home/sessions/`. Eureka + copilot_sdk sessions store SDK events at `<sessionPath>/.copilot-sdk/session-state/<sdkSessionId>/events.jsonl`. Fallback never matches. | `src/parsers/eureka.ts:426-439` |
| **B4** | copilot_sdk telemetry undercount | `llm-telemetry.jsonl` for copilot_sdk records one entry per `assistant.turn_end` (interaction boundary), NOT per LLM API call. Real example (260418-quiet-woods round 1): SDK shutdown reports 2 requests / 61112 input / 1181 output, telemetry has 1 record / 32389 / 213 → ~50 % undercount. | Eureka runtime + parser interaction |

Out of scope: `claimedCcSessionIds` semantics, OAuth, marsRegistry — all unchanged.

---

## 2. Goals

1. Eliminate truncation-induced token loss for CC `.jsonl` files of any size.
2. For Eureka + copilot_sdk sessions, prefer authoritative SDK `events.jsonl` over telemetry whenever it exists.
3. When SDK file is unavailable, keep current accumulation behavior **and** mark the result as estimated rather than authoritative.
4. No behavior change for paths already known to be correct.
5. All fixes covered by unit + E2E tests.

---

## 3. Architecture

### 3.1 Streaming jsonl reader (shared helper)

New file: `src/parsers/util/jsonl-stream.ts`

```ts
export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Stream a JSONL file line-by-line, calling `onLine` for each parsed object.
 * Memory-bounded regardless of file size. Skips malformed lines silently.
 * Returns null if the file is missing.
 */
export async function streamJsonl(
  filePath: string,
  onLine: (obj: unknown, lineNo: number) => void,
): Promise<{ linesRead: number; bytesRead: number } | null>;
```

Uses `fs.createReadStream` + `readline.createInterface`. No 5 MB threshold, no head/tail trick.

### 3.2 claude-code.ts changes

- Replace the head+tail branch in `parseClaudeSessionFile` and the helper functions `extractTokensFromCcFile` / `extractUsageFromString` with a single streaming pass via `streamJsonl`.
- Per line: pull `message.usage` (or top-level `usage`) and accumulate.
- Behaviorally identical to the line-by-line path that exists for files ≤ 5 MB today; just removes the threshold-and-truncate branch.

### 3.3 eureka.ts changes

**B2 fix (truncation):** Replace `readFileWithSizeLimit` callers that feed CC jsonl into token extraction with `streamJsonl`. Delete `readFileWithSizeLimit` and the dead `hasNonAnthropicTokens` variable.

**B3 fix (copilot_sdk path):** Generalize `readCodexSessionTokens` → `readSdkSessionTokens(sessionPath, sdkSessionId, fallbackModel)`. Probes (in order):
1. `<sessionPath>/.copilot-sdk/session-state/<sdkSessionId>/events.jsonl` → copilot SDK
2. `<sessionPath>/.codex-home/sessions/**/<sdkSessionId>*.jsonl` → codex SDK (existing)

**Return contract** (must match what the current `readCodexSessionTokens` populates at `eureka.ts:307-342`):
```ts
type SdkSessionResult = {
  tokens: TokenBreakdown;          // aggregate across all models
  modelUsage: Record<string, TokenBreakdown>;  // per-model split (for "Cost by Model")
  models: string[];                // list of model IDs observed (caller chooses primary)
  provenance: TokenProvenance;     // "sdk-shutdown" | "sdk-events" | "sdk-codex-rollout"
} | null;
```

**Multi-model handling for copilot `session.shutdown`:** `data.modelMetrics` is keyed by model ID. Each entry contributes its `usage` to both the aggregate `tokens` and `modelUsage[modelId]`; `models` is the sorted list of keys with non-zero usage.

**Model-key mismatch fallback:** If `session.shutdown.modelMetrics` does not contain `fallbackModel` AND no other models have non-zero usage (effectively empty shutdown), fall back to per-event accumulation (`provenance = "sdk-events"`); per-event records are attributed to `fallbackModel` since copilot per-event payloads do not carry a model field.

**Codex branch unchanged:** Returns `provenance = "sdk-codex-rollout"`, otherwise the existing shape (single model = `fallbackModel`, single `tokens` block) is preserved verbatim.

**B4 fix (copilot_sdk accumulation when SDK file present):**

For each line in `events.jsonl` (parsed via `streamJsonl`):

| Event type | Action |
|---|---|
| `session.shutdown` | Read `data.modelMetrics.<model>.usage` if present and `model` matches; treat this as **authoritative** for the entire session. If multiple shutdowns exist (resume case), use the **last** one whose `modelMetrics` is non-empty. |
| Otherwise | If `data.usage` (object with at least one of `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`) appears, accumulate it. **Source `assistant.turn_end` events first if both `assistant.message` and `assistant.turn_end` carry usage** to avoid double-counting. Per-line accumulation is only used as fallback when no `session.shutdown.modelMetrics.<model>.usage` is found. |

**Token field mapping (copilot SDK → tokmon TokenBreakdown):**
```
input          ← max(0, inputTokens - cacheReadTokens)   // net input only
output         ← outputTokens
cacheRead      ← cacheReadTokens
cacheCreation  ← cacheWriteTokens
```
This mirrors the existing accumulation rule for OpenAI/Copilot in `eureka.ts:280-289`.

**Deduplication & resume handling:** Within a single `events.jsonl`, `session.start` followed by `session.resume` events are informational only — they do NOT reset accumulators. The whole file is treated as one logical session because Eureka resumes write into the same file.

**B4 fix when SDK file absent:** Keep current telemetry accumulation. Tag the resulting tokens via `provenance` (see 3.4) so consumers can distinguish.

### 3.4 Provenance field (replaces "meta.tokenSource")

Adds **one** optional field to `Session` in `src/core/types.ts`:

```ts
export type TokenProvenance =
  | "sdk-shutdown"        // copilot_sdk: from session.shutdown.modelMetrics — authoritative
  | "sdk-events"          // copilot_sdk: accumulated from per-event usage — best-effort
  | "sdk-cc-jsonl"        // claude_agent_sdk: from CC .jsonl streaming pass — authoritative
  | "sdk-codex-rollout"   // codex SDK rollout file — authoritative
  | "telemetry"           // llm-telemetry.jsonl, all per-call records intact
  | "telemetry-incomplete"// llm-telemetry.jsonl but undercounted (copilot_sdk multi-call turns or Anthropic running totals)
  | "none";               // No SDK file, no telemetry → tokens = 0 (per AGENTS.md §3.4)

export interface Session {
  // ...existing fields...
  tokenProvenance?: TokenProvenance;
}
```

**Assignment rules** (one per code path that produces a session):
| Parser path | Sets `tokenProvenance` to |
|---|---|
| claude-code.ts (independent CC) | `"sdk-cc-jsonl"` |
| codex.ts (independent codex) | `"sdk-codex-rollout"` |
| copilot-cli.ts | `"telemetry"` |
| eureka + claude_agent_sdk + SDK file reachable | `"sdk-cc-jsonl"` |
| eureka + claude_agent_sdk + SDK file missing | `"telemetry-incomplete"` |
| eureka + copilot_sdk + SDK file w/ shutdown | `"sdk-shutdown"` |
| eureka + copilot_sdk + SDK file w/o shutdown | `"sdk-events"` |
| eureka + copilot_sdk + no SDK file | `"telemetry-incomplete"` |
| eureka + codex_sdk + SDK file reachable | `"sdk-codex-rollout"` |
| eureka + no `sdkSessionId` | `"none"` (tokens = 0; per AGENTS.md L81-85, the underlying CC files, if any, are claimed by the CC parser independently) |

**Backwards compatibility:** Field is optional and additive. Golden corpus tests (`tests/corpus/parser-roundtrip.test.ts`) need a one-time golden regeneration via `npm run corpus:regenerate-golden` to absorb the new field. This is acknowledged scope-expansion vs. v1's "no production code outside parsers"; see §4.

### 3.5 Incremental cursor coverage for SDK files

Eureka's incremental skip currently keys off `session.jsonl` and `llm-telemetry.jsonl` mtime (`src/parsers/eureka.ts` around L130-144). Add `.copilot-sdk/session-state/<sdkSessionId>/events.jsonl` and codex rollout files to the same `max(...)` mtime computation that drives the cursor skip decision.

Implementation: introduce a small helper `getEurekaSessionMtime(sessionPath, sdkSessionId?)` that takes `Math.max(session.jsonl.mtimeMs, llm-telemetry.jsonl.mtimeMs, copilot-sdk events.jsonl.mtimeMs?, codex rollout.mtimeMs?)`, and use it as the comparison source in the cursor skip block. Helper is local to `eureka.ts`; no exported API change.

---

## 4. File-Level Changes

| File | Change |
|------|--------|
| `src/parsers/util/jsonl-stream.ts` | **New**, ~50 lines. |
| `src/parsers/claude-code.ts` | Drop `extractTokensFromCcFile` + `extractUsageFromString` + 5 MB branch. Set `tokenProvenance = "sdk-cc-jsonl"`. |
| `src/parsers/codex.ts` | Set `tokenProvenance = "sdk-codex-rollout"`. |
| `src/parsers/copilot-cli.ts` | Set `tokenProvenance = "telemetry"`. |
| `src/parsers/eureka.ts` | Drop `readFileWithSizeLimit`, dead `hasNonAnthropicTokens`. Rename `readCodexSessionTokens` → `readSdkSessionTokens` and add copilot_sdk branch with shutdown-priority logic. Set `tokenProvenance` per matrix above. Extend mtime probe per §3.5. |
| `src/core/types.ts` | Add `TokenProvenance` type and optional `tokenProvenance` field on `Session`. |
| `tests/unit/parsers/jsonl-stream.test.ts` | **New** unit tests. |
| `tests/unit/parsers/claude-code-large.test.ts` | **New** — synthetic 6 MB fixture, asserts no token loss. |
| `tests/unit/parsers/eureka-copilot-sdk.test.ts` | **New** — fixtures mirroring real `events.jsonl`. |
| `tests/unit/parsers/eureka-token-provenance.test.ts` | **New** — verifies provenance matrix. |
| `tests/e2e/collect-token-accuracy.test.ts` | **New** E2E using `collectCommand` API directly. (Placed under `tests/e2e/` because that directory is included in `npm run test:unit`; see `package.json` line 42.) |
| `tests/corpus/parser-roundtrip.test.ts` | No code change. Golden files regenerated via `npm run corpus:regenerate-golden` after `tokenProvenance` is added. |

No CLI flags are added; E2E uses the public `collectCommand({ reset: true })` API exported from `src/cli/commands/collect.ts` (already used by `tests/unit/collect.test.ts`).

---

## 5. Acceptance Criteria

1. `tsc -b` passes.
2. All existing tests pass after one-shot golden regeneration (documented in commit message).
3. New tests (paths in §4) all pass.
4. **E2E**: `tests/e2e/collect-token-accuracy.test.ts` runs `collectCommand` against `tests/fixtures/sessions/` (4 sub-trees: cc-large / eureka-anthropic / eureka-copilot-sdk-with-shutdown / eureka-copilot-sdk-no-shutdown) and asserts both token totals AND `tokenProvenance` match expected JSON. Test runs as part of `npm run test:unit` (which includes `tests/e2e/`).
5. No new runtime dependencies in `package.json`.
6. No regression in `tests/corpus/` once golden is regenerated (i.e., diff after regeneration only adds the new optional field, no token-number drift).

---

## 6. Test Strategy

### 6.1 Unit tests

| File | Scenarios |
|------|-----------|
| `jsonl-stream.test.ts` | Empty file. Single line. 100 K lines (memory delta < 50 MB). Malformed line in middle. Missing file → `null`. Truncated last line (no trailing `\n`). |
| `claude-code-large.test.ts` | Build 6 MB fixture in `beforeAll` by repeating known-shape line N times. Assert exact total. |
| `eureka-copilot-sdk.test.ts` | (a) `events.jsonl` with `session.shutdown.modelMetrics` → assert SDK-shutdown wins, provenance=`sdk-shutdown`. (b) Same minus shutdown → assert per-event accumulation, provenance=`sdk-events`. (c) Shutdown lacks the model → fall back to (b). (d) Resume with two shutdowns → use last. |
| `eureka-token-provenance.test.ts` | One test case per row of the §3.4 matrix. |

### 6.2 E2E test

`tests/e2e/collect-token-accuracy.test.ts`:
- Build `tests/fixtures/sessions/{cc-large, eureka-anthropic, eureka-copilot-sdk-with-shutdown, eureka-copilot-sdk-no-shutdown}/` mirroring real layout.
- Override config to point all source roots into the fixture tree.
- Call `collectCommand({ reset: true })`.
- Read resulting `MachineData` from disk via the same loader the dashboard uses.
- Assert each session's `tokens` and `tokenProvenance` match an `expected.json` checked into the fixture dir.

### 6.3 Edge cases

- File deleted between stat and stream → caught, returns `null`.
- 0-byte file → zero usage.
- Truncated last line → readline emits, parse error swallowed.
- `EACCES` on `.copilot-sdk/` → fallback returns `null`, `tokenProvenance = "telemetry-incomplete"`.
- Two `session.shutdown` events (resume + final exit) → last one with non-empty `modelMetrics.<model>.usage` wins.
- Shutdown's `modelMetrics` keyed by a model that doesn't match selected model → falls back to per-event accumulation.

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Streaming a 100 MB file slows `collect` significantly | E2E benchmarks via `process.hrtime`; budget < 2× current time. |
| Removing 5 MB threshold breaks something downstream | Grep confirms `5 * 1024 * 1024` referenced only in the two files being changed. |
| Adding `tokenProvenance` breaks corpus golden | One-shot regeneration via existing `regenerate-golden.ts`; reviewer to inspect diff (must show only new field added, no token drift). |
| copilot SDK event format may evolve | Tests pin against captured real-shape events; format change → test failure. |
| Cursor extension causes more reparse work | Bounded — only triggers when SDK file's mtime > primary file's mtime, which is rare. |

---

## 8. Reviewer Checklist (Phase 4)

- [ ] Scope clear?
- [ ] Interfaces well-defined? (`streamJsonl`, `readSdkSessionTokens`, `TokenProvenance`)
- [ ] copilot_sdk no-shutdown semantics specified?
- [ ] `tokenProvenance` matrix complete?
- [ ] E2E test invocation actually works (uses `collectCommand` API)?
- [ ] Test paths match repo convention (`tests/unit/parsers/...`)?
- [ ] Risks acceptable?
