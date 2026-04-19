# DESIGN: Parse-then-Attribute Refactor

## Motivation

The current parser pipeline interleaves **parsing** (reading SDK files) with **orchestrator attribution** (deciding whether a session belongs to Mars / Eureka / nothing). This coupling has produced a string of hard-to-diagnose bugs:

1. **Eureka claim race** — `eurekaParser` populates a global `claimedCcSessionIds` set during `parse()`. The CC parser later consults it. Legacy cursors (pre-claim mechanism) hit the cursor cache fast-path and never re-register the claim → the CC parser walks the same SDK `.jsonl` and double-counts $1095 / 183 sessions per oscillation.
2. **`telemetry-incomplete` death loop** — when a remote-machine SDK file is missing, Eureka writes the session as `telemetry-incomplete` and marks its cursor stale. Next collect re-parses, still missing, still stale → cursor never settles, parsing wastes time, and `mergeSession` repeatedly overwrites enriched cost back to 0.
3. **`mergeSession` attribution loss** — `mergeSession` does `{ ...updated, createdAt: existing.createdAt }`. If the new parser run produces a session without an orchestrator tag (e.g., the Mars registry was momentarily empty because the DB was locked), the existing tag is silently dropped.
4. **Order coupling** — the parser order in `src/parsers/index.ts` (`mars → eureka → claude-code → codex → copilot-cli`) is **load-bearing**: `mars` must populate `marsRegistry` before CC reads it, and `eureka` must populate `claimedCcSessionIds` before CC reads it. There's no compile-time signal of this dependency.

All four bugs share a root cause: **attribution is a side effect of parsing, mediated by mutable globals**.

This design separates the two concerns: parsers produce raw sessions; attribution runs as a deterministic, pure post-processing pass.

## Non-Goals

- No changes to on-disk file formats (cursor schema, `<machineId>.json`, etc).
- No changes to enrichment / pricing.
- No new sources or features. Pure refactor + bug fix.
- Not removing the `diag-log.ts` instrumentation. It stays as a safety net.

---

## Diagnostic Findings

Captured from `~/.tokmon/logs/diag.log` after one user-driven reproduction:

| Symptom | Numbers |
|---|---|
| `eureka.session.write` events with `tokenProvenance: telemetry-incomplete` | 13,051 of 13,114 (99.5%) |
| `eureka.session.write` with `cursorWasStale: true` | ~all of the above |
| Distinct Eureka sessions on the machine | ~353 |
| Implication | Each session is re-parsed ~37× across collects, all producing cost=0 |
| Independent CC sessions appearing in some collects | 183 sessions / +$1097.89 |
| Same machine's stable totals (no Eureka miss) | 4,422 sessions / ~$3,700 |
| Difference when CC parser "wins the race" | +183 / +$1097 (~$27 per collect after deltas) |

**Root cause confirmed**: 353 historical Eureka sessions reference SDK `.jsonl` files that are no longer present on this machine (CC's own log rotation / disk cleanup). Eureka cannot read tokens → marks `telemetry-incomplete` → cursor never stabilizes → CC parser opportunistically scoops up any SDK file Eureka didn't claim this round.

---

## Architecture

### Phases (replaces today's 5 sequential parsers)

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 0: DISCOVER ROOTS  (filesystem only; no DB; no parse) │
│   - Scan Mars app-support dirs and configured "mars" sources│
│     to enumerate extra scan roots:                          │
│       claudeRoots   = [...]                                 │
│       codexRoots    = [...]                                 │
│       copilotRoots  = [...]                                 │
│   Produces a ParseRoots object consumed by Phase 1.         │
│   This replaces today's side-effect where marsParser had to │
│   run before the SDK parsers so they could see Mars roots.  │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Phase 1: PARSE (independent, parallelizable)                │
│   - claudeCodeParser.parse(ctx, parseRoots)  → raw CC       │
│   - codexParser.parse(ctx, parseRoots)       → raw Codex    │
│   - copilotCliParser.parse(ctx, parseRoots)  → raw Copilot  │
│   No claim sets. No Mars DB lookup. No Eureka lookup.       │
│   Pure file → Session over (default roots ∪ parseRoots).    │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Phase 2: INDEX (build attribution sources)                  │
│   - marsRegistry  ← read marsiwe.db (sessions × tasks × ws) │
│       Note: root-discovery already happened in Phase 0.     │
│       Phase 2 only loads the SQLite rows used for tagging.  │
│   - eurekaIndex   ← scan ~/.craft-agent/workspaces/         │
│         eurekaIndex maps                                    │
│           (sdkSessionId, sdkCwd?) → EurekaIndexEntry        │
│         Composite key — see "Eureka index keying" below.    │
│   No sessions produced yet. Pure index builders.            │
│   May run in parallel with Phase 1.                         │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Phase 3: ATTRIBUTE (pure function over Phase 1 + Phase 2)   │
│   for session in [...cc, ...codex, ...copilot]:             │
│     hit = eurekaIndex.lookup(session.id, session.cwd)       │
│     if hit:                                                 │
│       session.orchestrator = { kind: "eureka", ... }        │
│       session.id = hit.eurekaSessionId          ← rekey     │
│     elif marsRegistry.has(session.id):                      │
│       session.orchestrator = { kind: "mars", ... }          │
│   Attribution is deterministic given inputs.                │
│   Returns (attributed, matchedEurekaCompositeKeys).         │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Phase 4: ORPHAN-INGEST (Eureka sessions w/o SDK file)       │
│   For each entry in eurekaIndex NOT matched in Phase 3:     │
│     emit a synthetic Session with                           │
│       source = inferUnderlyingSource(eureka.runtimeProvider)│
│       model  = eureka.headerModel ?? "unknown"              │
│       tokens = eureka.telemetryTokens (may be 0)            │
│       tokenProvenance = "telemetry"  or  "none"             │
│       orchestrator = { kind: "eureka", ... }                │
│   Replaces today's "telemetry-incomplete" code path.        │
│   Distinguishes "really has no tokens" from "SDK missing".  │
└──────────────────┬──────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────┐
│ Phase 5: ENRICH + PERSIST                                   │
│   1. Concatenate Phase 3 attributed + Phase 4 orphans.      │
│   2. enrichSessionsBatched(all)  — tokens × pricing → cost. │
│   3. updateSessions(machineData.sessions, enriched, ...)    │
│   4. saveMachineData(...)                                   │
│   Critical ordering: enrich BEFORE updateSessions/save.     │
│   This is the invariant that prevents zero-cost overwrites. │
└─────────────────────────────────────────────────────────────┘
```

### Eureka index keying

`eurekaIndex` is keyed by `(sdkSessionId, sdkCwd)` as a composite key, with a fallback lookup by `sdkSessionId` alone:

```ts
lookup(sdkSessionId, cwd?):
  1. if (sdkSessionId, cwd) hit  → return it
  2. else if exactly one entry has sdkSessionId → return it
  3. else (collision across cwds, no cwd context) → log warn, return null
```

This makes the collision policy part of the API contract, not a comment.

### What Goes Away

| Today | After refactor |
|---|---|
| `claimedCcSessionIds: Set<string>` (mutable global) | Deleted |
| `cursor.claimedSdkSessionId` field | Deprecated; ignored on read, not written |
| `cursor.claimedSdkCwd` field | Same |
| `cursor.lastProvenance === "telemetry-incomplete"` cursor invalidation | Deleted (Phase 4 handles it deterministically) |
| Parser order coupling (Mars must precede CC, Eureka must precede CC) | Gone — Phase 1 parsers are independent |
| `mergeSession` orchestrator-loss / attribution-change diag log | Deleted (cannot fire in healthy state; deterministic attribution makes it dead code) |
| Eureka parser's three-branch SDK token reader | Moves to Phase 4 only as fallback |

### What Stays

- All file format parsers (CC `.jsonl`, Codex rollouts, Copilot events) — they keep their stream code, only the public entrypoint changes.
- Cursors (still per-file, still inode/size/mtime fingerprinted) — but Eureka cursors no longer carry `claimedSdk*` data.
- `marsRegistry` builder logic — moves into Phase 2 unchanged.
- All diagnostic logging — moves to phase boundaries.

---

## Interfaces

```ts
// Phase 0: discover scan roots from Mars app-support directories.
interface ParseRoots {
  claudeRoots: string[];
  codexRoots: string[];
  copilotRoots: string[];
}
function discoverParseRoots(ctx: ParserContext): Promise<ParseRoots>;

// Phase 1: parsers stop caring about orchestration. They DO accept extra
// scan roots from Phase 0 (preserves today's Mars-managed-session discovery).
interface BaseParser {
  source: "claude-code" | "codex" | "copilot-cli";
  parse(ctx: ParserContext, extraRoots: string[]): Promise<{
    sessions: Session[];
    cursorUpdates: Record<string, FileCursor>;
  }>;
}
// Same shape as today minus the Eureka/Mars side effects, plus an explicit
// extraRoots parameter so Mars-managed sessions remain discoverable.

// Phase 2: index builders.
interface MarsRegistry {
  byAgentSessionId: {
    claudeCode: Map<string, MarsSessionMeta>;
    codex: Map<string, MarsSessionMeta>;
    copilotCli: Map<string, MarsSessionMeta>;
  };
  // Note: scan roots moved to ParseRoots (Phase 0). MarsRegistry is now
  // strictly the SQLite-derived attribution map.
}
function buildMarsRegistry(ctx: ParserContext): Promise<MarsRegistry>;

interface EurekaIndexEntry {
  eurekaSessionId: string;       // e.g. "260418-alert-rose"
  workspaceId: string;
  underlyingSource: Source;       // claude-code | codex | copilot-cli
  sdkSessionId: string;
  sdkCwd?: string;
  // For Phase 4 orphan synthesis (Session.model is required + used by pricing):
  headerModel?: string;          // best-effort model from Eureka session header
  telemetryTokens?: TokenBreakdown;
  telemetryProvenance?: TokenProvenance;
  // Metadata used to build the synthetic Session:
  workspacePath?: string;
  workingDirectory?: string;
  engine?: string;
  runtimeProvider?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTimestampsMs: number[];
  name?: string;
  sessionType?: string;
  messageCount?: number;
  userTurns?: number;
}

interface EurekaIndex {
  // Composite-key storage. Lookup falls back to sdkSessionId-only when
  // there is exactly one entry for that id (see "Eureka index keying").
  byCompositeKey: Map<string, EurekaIndexEntry>;   // key = `${sdkSessionId}::${sdkCwd ?? ""}`
  bySdkSessionId: Map<string, EurekaIndexEntry[]>; // for fallback + collision detection
  lookup(sdkSessionId: string, sdkCwd?: string): EurekaIndexEntry | undefined;
}
function buildEurekaIndex(ctx: ParserContext): Promise<EurekaIndex>;

// Phase 3: pure attribution.
// Returns matched composite keys (not bare sdkSessionId) so Phase 4 can
// correctly skip the right entries even when two Eureka entries share an
// sdkSessionId across different cwds.
function attributeOrchestrator(
  sessions: Session[],
  marsRegistry: MarsRegistry,
  eurekaIndex: EurekaIndex,
): {
  attributed: Session[];                    // input sessions, possibly rekeyed + tagged
  matchedEurekaCompositeKeys: Set<string>;  // keys from EurekaIndex.byCompositeKey
};

// Phase 4: orphan ingest. Orphan model resolution rule:
//   model = entry.headerModel ?? "unknown"
// (Phase 5 pricing is no-op for "unknown" — cost stays 0, which is correct
// when we have no model signal.)
function ingestEurekaOrphans(
  eurekaIndex: EurekaIndex,
  matchedCompositeKeys: Set<string>,
  machineId: string,
): Session[];

// Phase 5: enrichment + persistence.
//   const all = [...attributed, ...orphans];
//   const enriched = await enrichSessionsBatched(all, machineId, config);
//   machineData.sessions = updateSessions(machineData.sessions, enriched, machineId);
//   await saveMachineData(machineData, machineName);
// Required ordering: enrich → updateSessions → save. Persisting before
// enrichment is what produced today's zero-cost overwrite bug.
```

---

## Cost Reconciliation

Today, Eureka has its own cost path because `parseEurekaSession` reads SDK tokens (when available) and writes them as the session's tokens. Under parse-then-attribute, the picture cleans up:

| Case | Source of tokens | Source of cost |
|---|---|---|
| SDK file present | CC/Codex/Copilot parser (Phase 1) | Phase 5 enrichment, tokens × pricing |
| SDK file missing, telemetry has totals | Phase 4 orphan, telemetry tokens | Phase 5 enrichment |
| SDK file missing, no telemetry totals | Phase 4 orphan, tokens=0 | Phase 5 → 0 (correct: we have no signal) |

**Key invariant**: there is exactly **one** Session for each (machineId, source, sessionId) triple. Eureka rekeys the SDK session's id to the Eureka session id when matched, so the SDK session never appears as a separate row.

This kills today's two pathological states:
- **Double-count** (SDK session appears as both Eureka-tagged and untagged CC) — impossible because rekey is deterministic.
- **Cost-drop** (re-parse overwrites enriched cost with 0) — impossible because Phase 5 always runs over the final session list, and Phase 1+4 produce stable session ids.

---

## Migration

Direct cutover on `feat/eureka-orchestrator-split`. Users will run `tokmon --reset` once after upgrade to rebuild their store from the new pipeline. No feature flag, no side-by-side validation — the corpus + new unit tests cover the regression surface.

### Step 1 — New code surfaces

1. Add `src/core/parse-roots.ts` exporting `discoverParseRoots(ctx) → ParseRoots`. Pure filesystem scan over Mars app-support dirs and configured `mars` sources. No DB access, no Session emission. Replaces today's side effect where `marsParser.parse()` had to populate `marsRegistry.{claude,codex,copilot}Roots` before SDK parsers ran.
2. Add `src/parsers/eureka-index.ts` exporting `buildEurekaIndex(ctx) → EurekaIndex`. No Session emission. Replaces `src/parsers/eureka.ts`. Index includes `headerModel` so Phase 4 can construct valid `Session.model`.
3. Add `src/core/attribute.ts` with `attributeOrchestrator(sessions, marsReg, eurekaIdx)` and `ingestEurekaOrphans(eurekaIdx, matchedIds, machineId)`. Pure functions.
4. Refactor `src/parsers/mars.ts` to expose only `buildMarsRegistry(ctx)`. Drop the `Parser` interface (it never produced sessions anyway) and drop the `claudeRoots/codexRoots/copilotRoots` fields from `MarsRegistry` (they migrate to `ParseRoots`).
5. Refactor `claudeCodeParser`, `codexParser`, `copilotCliParser` to accept `extraRoots: string[]` directly instead of reading from `marsRegistry`.

### Step 2 — Pipeline rewire

In `src/cli/commands/collect.ts`:
1. Run Phase 0 `discoverParseRoots(ctx)` once. Cheap filesystem scan.
2. Run Phase 1 SDK parsers (CC, Codex, Copilot) with `extraRoots` from Phase 0. No consultation of Mars/Eureka.
3. Run Phase 2 index builders (`buildMarsRegistry`, `buildEurekaIndex`) — may run in parallel with Phase 1.
4. Run Phase 3 `attributeOrchestrator` over Phase 1 output.
5. Run Phase 4 `ingestEurekaOrphans` for unmatched Eureka entries.
6. Phase 5: `const all = [...attributed, ...orphans]; const enriched = await enrichSessionsBatched(all, …); machineData.sessions = updateSessions(machineData.sessions, enriched, machineId); await saveMachineData(...)`.
   - **Required ordering**: enrich BEFORE updateSessions/save. Persisting before enrichment is what produced the zero-cost overwrite.
   - This replaces today's per-parser enrich-then-concat loop in `collect.ts:101-134`.

### Step 3 — Delete old code

Source files:
- `claimedCcSessionIds` (in `src/parsers/eureka.ts`) and all CC/Eureka references to it.
- `cursor.claimedSdkSessionId`, `cursor.claimedSdkCwd`, `cursor.lastProvenance` fields and the legacy-cursor / `telemetry-incomplete` invalidation logic in `src/core/cursor.ts` and `src/parsers/eureka.ts`.
- The Session-emission body of `src/parsers/eureka.ts` (replaced by `src/parsers/eureka-index.ts`).
- The `mergeSession` orchestrator-loss / attribution-change diag log in `src/core/data.ts` (no longer reachable; see "What Goes Away" — this is the canonical decision).
- `marsParser` Parser-interface adapter in `src/parsers/mars.ts` (kept only as `buildMarsRegistry`).
- `marsRegistry.{claudeRoots,codexRoots,copilotRoots}` field reads in `src/parsers/{claude-code,codex,copilot-cli}.ts` (replaced by the `extraRoots` parameter).

Test files (these still encode old coupling and must be updated/deleted):
- `tests/corpus/helpers/build-attribution.ts` — current attribution helper.
- `tests/unit/build-attribution.test.ts` — asserts old helper behavior.
- `tests/unit/parsers/eureka.test.ts` — uses `claimedCcSessionIds`.
- `tests/unit/parsers/eureka-token-provenance.test.ts` — asserts `telemetry-incomplete` provenance from current parser.
- `tests/unit/eureka-parser.test.ts` — legacy-cursor regression, must be replaced (see Step 4).
- `tests/unit/corpus-goldens.test.ts` — golden assertions that depend on current Session emission shape.

### Step 4 — Tests

- All existing unit + corpus tests must pass after rewrites above.
- New unit tests for `attributeOrchestrator` (table-driven over fixtures): rekey on Eureka match, mars-tag fallback, no-tag default, composite-key collision logged.
- New unit tests for `buildEurekaIndex` (replaces today's `eureka-parser.test.ts` cases): claude/codex/copilot source inference, headerModel extraction, telemetry-token capture.
- New unit test for `ingestEurekaOrphans` covering the missing-SDK case (today's bug): emits orphan with correct `source`, `model="unknown"` when no header, tokens=0 when no telemetry, tokens=telemetry totals when present.
- New unit test for `discoverParseRoots`: enumerates Mars app-support dirs correctly, handles missing dirs.
- **New full-pipeline integration test** (covers both blocking invariants together): a fixture with one matched Eureka SDK session, one telemetry-backed Eureka orphan (SDK file absent), and one Mars-managed CC session under a Mars root. Run the collect pipeline twice and assert: (a) no duplicate standalone SDK row appears on the second run, (b) Mars-managed session still appears after the pipeline split, (c) total cost is stable across the two runs.
- Manual e2e: `tokmon --reset` on the user's real machine, verify Eureka orphan count = 353 and cost stable across consecutive `tokmon` invocations.

---

## What Gets Simpler

- **No mutable globals** crossing parser boundaries.
- **Parser order doesn't matter** in Phase 1 — they can run in parallel.
- **Cursors are pure file-state**: never carry attribution metadata.
- **`mergeSession`** can go back to a one-liner — `{ ...updated, createdAt: existing.createdAt }`. The attribution-drop diag log is deleted; deterministic attribution means it can't fire.
- **Tests**: Phase 3 is a pure function over fixtures; no fs needed.

## What Gets Harder

- **One extra pass over sessions** (Phase 3 + Phase 4). Negligible cost: O(N) over a few thousand sessions.
- **Slight increase in initial parse work**: CC parser now scans all SDK files (currently it skips Eureka-claimed ones). Cursor incremental machinery still applies, so the steady-state cost is basically unchanged.
- **Eureka orphan ingest** is new code surface that needs its own tests. Mitigated by the dedicated `ingestEurekaOrphans` unit test and the new full-pipeline integration test described in Migration Step 4.

---

## Open Questions

1. **Should `attributeOrchestrator` also rekey Mars sessions?** Today, Mars sessions appear under their CC/Codex/Copilot session id. Rekey-to-mars-task-id would be cleaner, but breaks any existing `<machineId>.json` rows. **Recommendation**: keep current keying; only attach the orchestrator tag.
2. **`eurekaIndex` collision when one sdkSessionId is reused across two Eureka sessions** (theoretically possible if a user copies a session dir). **Recommendation**: per the "Eureka index keying" contract, the lookup logs a warning and returns `null` when a bare-sdkSessionId lookup is ambiguous. The two entries can still be matched if Phase 1 emits sessions with distinct `cwd` values (composite-key path). This is a 1-in-a-million edge case.
3. **Cursor migration**: do we strip `claimedSdk*` from existing cursors, or just leave them as dead fields? **Recommendation**: leave them. Cursor schema is forward-compatible; old fields are ignored at read time.

---

## Decision Log

- **Pure-function attribution over event-bus** — considered using a pub/sub between parsers, but a single deterministic function is much easier to test and reason about.
- **Phase 4 as a separate step (not folded into Phase 3)** — keeps the pure-function property of Phase 3. Phase 4 emits new sessions, which is an effect; isolating it makes the data flow easier to follow.
- **Direct cutover, no side-by-side** — confirmed. Users run `tokmon --reset` once after upgrade. The corpus + new unit + integration tests cover the regression surface. (Supersedes the earlier "Side-by-side Stage 2" idea, which was written before the diag-log work narrowed the failure modes.)
