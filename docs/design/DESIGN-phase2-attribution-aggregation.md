# DESIGN — Phase 2: Attribution + Aggregation Tests + Edge Corpus

**Status:** Draft
**Owner:** jietong (Architect)
**Date:** 2026-04-18
**Parent:** [DESIGN-test-harness.md](./DESIGN-test-harness.md)
**Predecessor:** Phase 1 (sampling + parser-roundtrip) — DONE & APPROVED

---

## Goals

Extend the corpus harness from Phase 1 with:

1. **Attribution correctness tests** — verify cross-source linking:
   - **Eureka ↔ underlying engine** linking via `sdkSessionId` (Eureka session points to a Claude Code or Codex session that holds the actual token usage).
   - **Mars ↔ engine** linking via the orchestrator field (Mars task subtree groups several engine sessions).
   - **No double-counting:** a session claimed by Eureka/Mars must not also appear standalone in totals if our pipeline already attributes it.
2. **Aggregation correctness tests** — verify that totals, per-source, per-model, per-project, per-machine, per-day, and Mars-task breakdowns from `aggregate.ts` match golden numbers computed once and frozen.
3. **Edge corpus** — a second small snapshot `2026-04-edge` constructed from hand-crafted (synthetic) fixtures covering tricky cases that the default real-sample corpus may not exhibit:
   - Eureka session whose `sdkSessionId` is missing from CC dir (orphan — must yield 0 tokens, not crash).
   - Eureka + Codex pairing.
   - Multi-model session (mixed haiku + opus calls).
   - Sub-agent file under `{sessionId}/subagents/` linked to parent via `sdkSessionId`.
   - Large jsonl file (>5MB) triggering head/tail mode.
   - Malformed line in middle of a jsonl file.
   - Mars task with 2 child engine sessions.

The harness must remain **deterministic in CI** — no real PII, no clock drift, no machine-specific paths.

## Non-goals

- New parser changes (Phase 2 is **tests only**, except for tiny aggregator helper extraction if needed for testability — to be agreed in design review).
- UI / E2E (Phase 3).
- Performance benchmarks.

---

## Architecture

### New artifacts

```
tests/corpus/
  attribution.test.ts           # NEW — runs across all corpora
  aggregation.test.ts           # NEW — runs across all corpora
  helpers/
    aggregate-from-sessions.ts  # NEW — pure aggregator that takes Session[] (no machine-data IO)
  snapshots/
    2026-04-default/
      golden/
        sessions.json           # exists
        attribution.json        # NEW
        aggregates.json         # NEW
    2026-04-edge/               # NEW corpus (hand-crafted)
      home/                     # synthetic fixtures (no sample step needed)
      golden/
        sessions.json
        attribution.json
        aggregates.json
      manifest.json
      README.md
tests/corpus/build-edge/
  build-edge.ts                 # NEW — script to (re)generate the edge corpus from synthetic builders
tests/corpus/corpora.json       # UPDATE — register 2026-04-edge
```

### Aggregation testability

`aggregateData()` in `src/core/aggregate.ts` reads from disk via `loadMachineData` + `loadRemoteMachines`. For corpus tests we want a **pure** path that takes `Session[]`. The existing exports (`computeTotals`, `buildProjectSummaries`, `buildBreakdownItems`, `applyFilters`, `applyComparisonFilters`) cover most rollups but **not** `perDay` and **not** any "leaderboards" shape. We do NOT extend `DataResponse`; instead the test helper composes a richer `AggregatesGolden` shape that is **golden-file-only** (lives in tests, not in production):

```ts
// tests/corpus/helpers/aggregate-from-sessions.ts
export interface AggregatesGolden {
  totals: ReturnType<typeof computeTotals>;          // existing
  perSource:    BreakdownItem[];                     // buildBreakdownItems(sessions, "source")
  perModel:     BreakdownItem[];                     // buildBreakdownItems(sessions, "model")
  perMachine:   BreakdownItem[];                     // buildBreakdownItems(sessions, "machine")
  perMarsTask:  BreakdownItem[];                     // buildBreakdownItems(sessions, "mars-task")
  perDay:       Array<{ date: string; cost: number; sessions: number; tokens: number }>; // helper
  projects:     ProjectSummary[];                    // buildProjectSummaries(sessions, [], nameById)
  leaderboards: { topProjects: string[]; topModels: string[] };  // top 10 by cost
}

export function aggregateFromSessions(sessions: Session[]): AggregatesGolden;
```

`perDay` is computed by a tiny pure helper inside the same file (group `session.createdAt.slice(0,10)` → sum cost/tokens/sessions, sort ascending). `topProjects`/`topModels` are derived from `projects` and `perModel` (already cost-sorted). No production-code changes.

**Per-model semantics:** the `perModel` rollup uses `session.model` (matches `buildBreakdownItems(_, "model")`). UI's "Cost by Model" uses `modelUsage` proportional attribution — that is **out of scope** for Phase 2 (attribute it as a separate Phase 3 UI test). Documented to avoid confusion.

---

## Attribution model recap (verified against current code)

From `src/parsers/eureka.ts`, `src/parsers/mars.ts`, `src/parsers/orchestrator.ts`, and `src/core/types.ts`:

- **Claude Code**: `source: "claude-code"`. Files at `~/.claude/projects/<encodedCwd>/<sid>.jsonl` AND `~/.craft-agent/.claude/projects/<encodedCwd>/<sid>.jsonl` (the latter is the Eureka-spawned CC dir). Both encode `cwd` by replacing `/` and `.` with `-`.
- **Eureka**: `source: "eureka"`, `engine` ∈ {"Eureka + CC", "Eureka + Codex"}. Eureka headers under `~/.craft-agent/workspaces/<wid>/sessions/<sid>/session.jsonl` carry `sdkSessionId` + `sdkCwd`. The parser links to:
  - **CC**: `getCraftAgentClaudeDirectory()/projects/<encodedSdkCwd>/<sdkSessionId>.jsonl` (NOT `~/.claude` — it is `~/.craft-agent/.claude`).
  - **CC sub-agents**: same dir, `<sdkSessionId>/subagents/*.jsonl`.
  - **Codex**: `<eurekaSessionPath>/.codex-home/sessions/**/*.jsonl` filtered by basename containing `sdkSessionId`.
- **`Session.orchestrator`** field set: only `kind`, `taskTitle`, `taskId`, `taskStatus`, `sessionName`, `marsSessionId`. **There is no `sdkSessionId` on `orchestrator`.** For attribution tests we expose linkage via the parser's module-level `claimedCcSessionIds` set (exported from `src/parsers/eureka.ts`) — read AFTER `parseAllPure` has run.
- **Mars**: `marsParser` returns `{ sessions: [], … }` — Mars itself emits no sessions. The CC/Codex/Copilot parsers, when discovering files under Mars's `agent-configs/{claude,codex,copilot}` roots, look up the session in the `marsRegistry` and call `applyMarsMeta` (in `orchestrator.ts`), which **mutates `engine`** to "Mars + CC" / "Mars + Codex" / "Mars + Copilot CLI" and sets `orchestrator.kind = "mars"`. The session's `source` stays `"claude-code"` / `"codex"` / `"copilot-cli"`. **There is no `source: "mars"`.** Mars detection in tests uses `orchestrator.kind === "mars"` and the `engine` label, not `source`.
- Mars sqlite DB lives at `<getMarsAppSupportDirectories()[0]>/marsiwe.db`. On Darwin that resolves to `~/Library/Application Support/com.marsiwe.app/marsiwe.db`. The corpus already places the sampled DB in this exact location (Phase 1 sampler handled this).

Attribution invariants we will assert (revised to match actual code):

| Invariant | How to check |
|---|---|
| Every Eureka session has `engine` ∈ {"Eureka + CC", "Eureka + Codex"} | filter `source === "eureka"` |
| Every Mars-orchestrated session has `orchestrator.kind === "mars"` AND `engine` starts with "Mars + " AND `source` ∈ {"claude-code","codex","copilot-cli"} | filter `orchestrator?.kind === "mars"` |
| `claimedCcSessionIds` (from `src/parsers/eureka.ts`) is non-empty when there are Eureka+CC sessions with nonzero tokens | read after `parseAllPure` |
| No CC session id appears both as a standalone CC session AND in `claimedCcSessionIds` | set intersection: `Set(cc_session.ids) ∩ claimedCcSessionIds === ∅` |
| Every Mars session has a `taskId` | filter check |
| Mars-task grouping: sessions sharing a `taskId` form the orchestration tree | group by `orchestrator.taskId`, assert tree member counts match golden |
| Eureka session's reported tokens equal the sum of tokens parsed from the linked CC/Codex file | optional: deferred to edge corpus where we control both sides |

The edge corpus (case 3) explicitly creates an orphan Eureka session — its **tokens must be all zeros**. Note: the parser adds `sdkSessionId` to `claimedCcSessionIds` **unconditionally** when it is set on the header, regardless of whether the linked file exists (see [eureka.ts](./src/parsers/eureka.ts) lines ~315/323). So an orphan Eureka session **WILL** appear in `claimedCcSessionIds` — this is intentional (it preempts any future CC file with that id from being double-counted). The attribution test asserts:
- orphan eureka session has `tokens.input === 0 && output === 0 && cacheCreation === 0 && cacheRead === 0`
- orphan eureka's `sdkSessionId` IS in `claimedCcSessionIds` (we accept this as correct behavior)
- there is no CC standalone session with that id (because we deliberately did not create the file).

---

## Golden file shapes

### Golden file shapes

`golden/attribution.json`:

```jsonc
{
  "summary": {
    "totalSessions": 89,
    "perSource":     { "claude-code": 16, "eureka": 30, "codex": 16, "copilot-cli": 16 },
    "perEngine":     { "Eureka + CC": …, "Eureka + Codex": …, "Mars + CC": …, … },
    "marsSessionCount": 11   // sessions where orchestrator.kind === "mars"
  },
  "eurekaLinkage": [
    { "eurekaSessionId": "...", "engine": "Eureka + CC", "tokens": { "input": …, "output": …, "cacheCreation": …, "cacheRead": … }, "resolved": true }
    // sorted by eurekaSessionId. "resolved" = (sum of tokens > 0). No sdkSessionId field on Session — we cannot include it without parsing eureka headers separately. We deliberately omit it from the golden to keep the test pure-Session-based.
  ],
  "marsTrees": [
    { "taskId": "...", "taskTitle": "...", "sessionIds": ["...", "..."], "totalCost": 0.12, "totalTokens": 1234 }
    // sorted by taskId
  ],
  "claimedCcSessionIds": ["...", "..."],   // sorted; sourced from src/parsers/eureka.ts module export
  "doubleCounting": {
    "ccIdsBothStandaloneAndClaimed": []     // expected empty
  }
}
```

`golden/aggregates.json` matches the `AggregatesGolden` interface above. Concrete shape:

```jsonc
{
  "totals":       { "sessions": 89, "turns": …, "durationSeconds": …, "tokens": {…}, "cost": {…}, "cacheHitRate": 0.… },
  "perSource":    [{ "key": "claude-code", "label": "claude-code", "cost": …, "sessions": … }, …],     // BreakdownItem[]
  "perModel":     [{ "key": "claude-opus-4-6",   "label": "…", "cost": …, "sessions": … }, …],
  "perMachine":   [{ "key": "machine",           "label": "machine", "cost": …, "sessions": … }],
  "perMarsTask":  [{ "key": "<taskTitle>",       "label": "<taskTitle>", "cost": …, "sessions": … }, { "key": "__untagged__", … }],
  "perDay":       [{ "date": "2026-04-15", "cost": …, "sessions": …, "tokens": … }, …],   // sorted asc by date
  "projects":     [ProjectSummary, …],
  "leaderboards": { "topProjects": ["projectKey1", …], "topModels": ["claude-opus-4-6", …] }
}
```

`perDay` is computed from `session.createdAt.slice(0,10)` — needs a tiny helper (pure, in `aggregate-from-sessions.ts`).

All numeric values are floating-point; we round costs to a fixed precision (e.g. 12 decimal places) before writing to keep diffs stable. **Decision point for design review:** rounding policy — proposal: serialize all numbers using `Number(n.toFixed(12))` to avoid IEEE noise.

### Determinism

- Numbers come purely from `Session[]`, which itself comes from the deterministic corpus (mtimes restored, content frozen). So aggregation is deterministic.
- Session ordering inside arrays is sorted by `(source, id)` (matches existing `normalizeForGolden`).
- All `cost` numbers are derived from a frozen pricing snapshot already present in the corpus' `home/.tokmon/pricing/` (Phase 1).

---

## Edge corpus `2026-04-edge`

### Why a separate corpus?

The default real-sampled corpus may not include rare shapes (orphan sdkSessionId, sub-agents, malformed lines). Building these from real data is fragile (hard to find / hard to keep deterministic). A **hand-crafted synthetic** corpus, generated by a small builder script, is the cleanest answer.

### Builder

The edge corpus is a **synthetic** snapshot built by a small Node script. **It does NOT live under `src/cli/commands/corpus/`** — that directory is compiled by `tsconfig.build.json` with `rootDir: "src"` and excludes `tests/**`, so it cannot import test fixtures. Instead we put the builder under `tests/corpus/` (already covered by the test tsconfig that includes both src and tests):

```
tests/corpus/build-edge/
  build-edge.ts        # main entry; programmatic API
  fixtures.ts          # synthetic builders (mirrors selected helpers from tests/helpers/fixtures.ts; copies what we need so we don't take a runtime dep)
```

A thin npm script invokes it via tsx (already a devDep):

```
npm run corpus:build-edge   →   tsx tests/corpus/build-edge/build-edge.ts --out tests/corpus/snapshots/2026-04-edge/
```

NO sampling / NO sanitization needed because nothing comes from real data — all content is synthetic (`testuser`, `/Users/testuser/...`, model names, deterministic timestamps).

After writing the home tree, the builder writes `manifest.json`, then invokes the same `parseAllPure` + `normalizeForGolden` pipeline (and the new `aggregateFromSessions` + `buildAttribution` helpers) to produce all three golden files.

### Cases included (all built from fixtures)

| Case | Files written (paths use exact parser conventions) |
|---|---|
| 1. Plain CC session | `home/.claude/projects/-Users-testuser-proj/<uuid>.jsonl` |
| 2. Eureka + CC normal pairing | `home/.craft-agent/workspaces/<wid>/sessions/<eid>/session.jsonl` (header) + `home/.craft-agent/.claude/projects/-Users-testuser-proj/<sdkSessionId>.jsonl` |
| 3. Eureka + CC orphan (sdkId not on disk) | only the eureka header file; no CC file |
| 4. Eureka + Codex pairing | `home/.craft-agent/workspaces/<wid>/sessions/<eid>/session.jsonl` (engine=codex header) + `home/.craft-agent/workspaces/<wid>/sessions/<eid>/.codex-home/sessions/2026/04/rollout-<sdkSessionId>.jsonl` |
| 5. Multi-model session | a CC jsonl with both haiku and opus assistant lines |
| 6. Sub-agent under `{sdkSessionId}/subagents/` | parent eureka header + CC file `home/.craft-agent/.claude/projects/<enc>/<sdkId>.jsonl` + sub-agent `home/.craft-agent/.claude/projects/<enc>/<sdkId>/subagents/sub1.jsonl` |
| 7. SKIPPED — see size budget | (unit-test only, not in edge corpus) |
| 8. Malformed mid-file line | valid lines + one `not-json\n` line + valid lines, in a plain CC file |
| 9. Mars task with 2 child sessions | Builder writes Mars files at **all platform paths** so discovery works on every CI OS: `home/Library/Application Support/com.marsiwe.app/` (Darwin) AND `home/.config/com.marsiwe.app/` (Linux/XDG default) AND `home/AppData/Roaming/com.marsiwe.app/` (Win32). Each location gets its own `marsiwe.db` + `agent-configs/claude/projects/<enc>/<sid1>.jsonl` + `<sid2>.jsonl`. Since `getMarsAppSupportDirectories()` returns only the current platform's paths, exactly one location is discovered per run — the parsed `Session` shape is platform-independent (no platform-specific paths land on `Session`), so the same golden works on Darwin/Linux/Win32. Total extra cost: ~3 KB × 3 copies < 10 KB. |
| 10. Codex telemetry-only session (no `total_token_usage`) | rollout file lacking the final event |

**Default corpus (`2026-04-default`) caveat:** It was sampled on Darwin and contains Mars files only at the Darwin path. On Ubuntu CI, the default corpus parses 0 Mars sessions — the existing golden reflects this (no Mars entries in `golden/sessions.json`). Phase 2 attribution/aggregation tests for the default corpus operate on whatever sessions parse on the current platform. The **edge corpus** is the canonical place to assert Mars semantics deterministically across platforms.

### Size budget

Hard cap: **< 200 KB total**. Case 7 (>5MB head/tail file) is **NOT** included in the edge corpus — it is already covered by Tier 1 unit fixtures. Acceptance criterion 6 enforces this.

---

## Test files

### `tests/corpus/attribution.test.ts`

```ts
describe.each(corpora)("attribution: $id", ({ id }) => {
  let sessions: Session[]; let golden: AttributionGolden;
  beforeAll(async () => {
    const corpus = await loadCorpus(id);
    await withCorpusEnv(corpus, async () => {
      sessions = normalizeForGolden(await parseAllPure({ forceAllSources: true }), corpus.manifest.epoch);
    });
    golden = JSON.parse(await fs.readFile(path.join(corpus.goldenDir, "attribution.json"), "utf8"));
  });

  it("matches summary counts", () => { expect(buildAttribution(sessions).summary).toEqual(golden.summary); });
  it("matches eureka linkage", () => { expect(buildAttribution(sessions).eurekaLinkage).toEqual(golden.eurekaLinkage); });
  it("matches mars trees", () => { expect(buildAttribution(sessions).marsTrees).toEqual(golden.marsTrees); });
  it("has no double-counting", () => { expect(buildAttribution(sessions).doubleCounting.ccIdsBothStandaloneAndClaimed).toEqual([]); });
});
```

`buildAttribution(sessions)` is a pure helper in `tests/corpus/helpers/build-attribution.ts`.

### `tests/corpus/aggregation.test.ts`

```ts
describe.each(corpora)("aggregation: $id", ({ id }) => {
  let actual: AggregatesGolden; let golden: AggregatesGolden;
  beforeAll(async () => { /* load + aggregateFromSessions + normalize */ });
  it("matches totals", () => expect(actual.totals).toEqual(golden.totals));
  it("matches per-source", () => expect(actual.perSource).toEqual(golden.perSource));
  it("matches per-model", () => expect(actual.perModel).toEqual(golden.perModel));
  it("matches per-mars-task", () => expect(actual.perMarsTask).toEqual(golden.perMarsTask));
  it("matches per-day", () => expect(actual.perDay).toEqual(golden.perDay));
  it("matches projects", () => expect(actual.projects).toEqual(golden.projects));
  it("matches leaderboards", () => expect(actual.leaderboards).toEqual(golden.leaderboards));
});
```

### Regeneration

A new test-side wrapper `tests/corpus/regenerate-golden.ts` produces `attribution.json` + `aggregates.json` after delegating to the existing src CLI for `sessions.json`. See "Note on `regenerate-golden.ts` composition" at the bottom of this doc. Wired via `npm run corpus:regenerate-golden` → `tsx tests/corpus/regenerate-golden.ts --corpus <dir>`.

---

## Test Strategy

### Unit tests (Tier 1 additions)

- `tests/unit/aggregate-from-sessions.test.ts` — feed hand-built `Session[]`, assert `aggregateFromSessions` returns expected totals/per-source/per-model. Covers rounding edge cases (tiny sums, zero sessions).
- `tests/unit/build-attribution.test.ts` — feed sessions with known eureka↔cc pairings (including orphan, double-claim) and assert helper output. Includes negative cases: simulated double-counting must show up in `doubleCounting.ccIdsBothStandaloneAndClaimed`.
- `tests/unit/build-edge.test.ts` — sanity: builder writes the expected files; pipeline parses them; no crashes.

### Corpus tests (Tier 2 additions)

- `tests/corpus/attribution.test.ts` — described above; runs against all corpora.
- `tests/corpus/aggregation.test.ts` — described above; runs against all corpora.
- Existing `tests/corpus/parser-roundtrip.test.ts` automatically picks up the new `2026-04-edge` corpus via the registry.

### E2E tests

E2E (Playwright) is Phase 3 scope. Phase 2 explicitly defers all UI work. The "E2E tests" required by the parent design's Test Strategy section are satisfied at this layer by the **end-to-end pipeline test**: corpus on disk → parser → enricher → aggregator → golden comparison, which is exactly what `parser-roundtrip.test.ts` and the new `aggregation.test.ts` perform. They exercise every pure module from input bytes to output `DataResponse`, with no mocking.

### Edge cases in tests

- Empty corpus (zero sessions) → totals all zero, no division by zero.
- Single session → per-day has one entry.
- All sessions same model → per-model has one row.
- Orphan eureka (case 3) → eurekaLinkage entry has `resolved: false`, `tokens` all zero.
- Malformed jsonl line (case 8) → parser must skip and continue; session still produced.

---

## Acceptance Criteria

1. New goldens written for `2026-04-default`: `attribution.json`, `aggregates.json`. Diffs reviewed and committed.
2. New corpus `2026-04-edge` committed (<200 KB) with all three golden files.
3. New tests pass locally and in CI: `attribution.test.ts`, `aggregation.test.ts`, plus unit tests for the helpers and the edge builder.
4. `corpora.json` lists both corpora.
5. `regenerate-golden` produces all three golden files in one invocation.
6. `verify` (Phase 1) still passes against both corpora; total disk footprint under 5 MB.
7. CI green.
8. No production code changes outside corpus tooling (parsers / aggregator unchanged). Test helpers compose existing exports.

---

## Open questions for design review — RESOLVED

1. **Number rounding for goldens.** Apply `Number(n.toFixed(12))` to **floating-point cost/cacheHitRate fields only**; integer counts (sessions, turns, tokens, durationSeconds) are written as-is.
2. **Per-day rollup helper location.** Lives in `tests/corpus/helpers/aggregate-from-sessions.ts`. Test-only — no production-code change.
3. **Edge corpus case 7 (>5MB).** SKIPPED from edge corpus. Tier 1 unit fixtures already cover it. Acceptance criterion 6 enforces <200 KB.
4. **`claimedCcSessionIds` source of truth.** Imported directly from `src/parsers/eureka.ts` (it is `export const claimedCcSessionIds = new Set<string>()`). Read in tests **after** `parseAllPure` has run. The set is reset at the start of each parse.
5. **`build-edge` CLI surface.** Not a `tokmon` subcommand. Lives under `tests/corpus/build-edge/build-edge.ts`, invoked via `npm run corpus:build-edge` (uses `tsx`). Keeps it out of the production build root.

---

## File layout summary

```
NEW:
  tests/corpus/build-edge/build-edge.ts
  tests/corpus/build-edge/fixtures.ts
  tests/corpus/helpers/aggregate-from-sessions.ts
  tests/corpus/helpers/build-attribution.ts
  tests/corpus/attribution.test.ts
  tests/corpus/aggregation.test.ts
  tests/corpus/snapshots/2026-04-edge/{home/, golden/, manifest.json, README.md}
  tests/corpus/snapshots/2026-04-default/golden/{attribution.json, aggregates.json}
  tests/unit/aggregate-from-sessions.test.ts
  tests/unit/build-attribution.test.ts
  tests/unit/build-edge.test.ts

MODIFIED:
  tests/corpus/regenerate-golden.ts              # NEW — test-side wrapper: writes attribution.json + aggregates.json (delegates sessions.json to existing src CLI)
  tests/corpus/corpora.json                       # add 2026-04-edge
  package.json                                    # add corpus:build-edge + corpus:regenerate-golden-all scripts
```

**Note on `regenerate-golden.ts` composition:** `regenerate-golden` lives under `src/` so it cannot import test helpers. Resolution: split — keep the existing `src/cli/commands/corpus/regenerate-golden.ts` writing **only** `sessions.json` (no change to its existing API), and add a new orchestrator script `tests/corpus/regenerate-golden.ts` (test-side wrapper) that:
1. Calls the existing `regenerateGolden(corpusRoot)` from src.
2. Then calls `aggregateFromSessions` + `buildAttribution` and writes the other two goldens.

Wired via `npm run corpus:regenerate-golden` → `tsx tests/corpus/regenerate-golden.ts --corpus <dir>`. The Phase-1 CLI subcommand still exists (back-compat) but produces only `sessions.json`. This isolates the build/test boundary cleanly.

No changes to `src/core/`. No changes to `src/parsers/`.
