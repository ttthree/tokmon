# Design: Align Eureka Source with Mars (Orchestrator-as-Dimension)

## Goal

Make `source` and `orchestrator` two **independent, orthogonal** dimensions throughout tokmon's data model and UI.

Currently, `source` mixes two concepts:
- **Underlying agent** (claude-code, codex, copilot-cli) — what actually consumed tokens
- **Orchestrator** (eureka, mars) — what spawned/coordinated the agent

Eureka and Mars are both orchestrators that spawn cc/codex/copilot child sessions. Their cost data ultimately comes from the **same underlying agent log files**. The only difference today: Eureka parser overwrites `source = "eureka"`, while Mars parser tags `orchestrator: { kind: "mars" }` and preserves the underlying source.

After this change:
- `source` is exclusively the underlying agent (what executed)
- `orchestrator` is the optional coordination layer (who launched it)
- UI exposes both as separate filters/views

## Scope

### In scope
1. Schema: shrink `Source` type, normalize Eureka session attribution
2. Parsers: Eureka parser sets `source` based on actual SDK branch
3. Aggregation: filters work on both dimensions
4. UI: separate Source + Orchestrator dropdowns; chart "stack by" toggle (source vs orchestrator)
5. Backward compatibility: API accepts old `source=eureka` query, server translates to `orchestrator=eureka`
6. Tests: parser unit tests, aggregation correctness, UI behavior
7. Migration note: cursor cache is preserved; only schema-affected fields are recomputed via existing enrichment path. No forced re-parse needed.

### Out of scope
- Recharts color palette overhaul (keep existing colors; just reassign which series gets which color when needed)
- Mars task title rollups (already exists in `aggregate.ts`; not touched)
- Persistence migration: see Backward Compatibility & Migration section below — load-time normalization rewrites both `Session.source` and the storage key.

## Architecture

### Type changes (`src/core/types.ts`)

The current `Source` type conflates three roles:
1. **Session attribution** — what underlying agent consumed tokens
2. **Source registration** — what kind of data source the user has configured (in `config.sources[]`)
3. **Parser identity** — what kind of parser this is (`Parser.source`, used for collect progress / SSE labels)

We split into two narrower types and keep a third for the registration/parser surface:

```ts
// BEFORE
export type Source = "claude-code" | "codex" | "copilot-cli" | "eureka" | "mars";

// AFTER
/** Underlying agent that consumed tokens. Used on Session.source. */
export type Source = "claude-code" | "codex" | "copilot-cli";

/** Orchestrator that coordinated the agent (optional). Unchanged. */
export type OrchestratorKind = "mars" | "eureka";

/** Type of registered data source / parser identity. Includes orchestrators
    because Mars and Eureka are real `SourceEntry`s in user config and have
    their own parsers (marsParser, eurekaParser). */
export type SourceType = Source | OrchestratorKind;
//        = "claude-code" | "codex" | "copilot-cli" | "eureka" | "mars"
```

Field assignments:
- `SourceEntry.type: SourceType` — registers cc/codex/copilot/eureka/mars
- `Parser.source: SourceType` — covers all parsers including `eurekaParser` and `marsParser`
- `Session.source: Source` — ONLY the underlying agent (no eureka, no mars)

This keeps Mars/Eureka as first-class registered sources and parsers, while constraining session-level attribution to the underlying agent.

### Eureka parser (`src/parsers/eureka.ts`)

The parser already branches on `runtimeProvider` / `engine`:
- `runtimeProvider.includes("copilot")` → calls `readSdkSessionTokens` (copilot events.jsonl)
- `engine.includes("codex") || runtimeProvider.includes("codex")` → calls `readSdkSessionTokens` (codex rollout)
- else → calls `readCcSessionTokens` (claude-code jsonl)

We'll capture the chosen branch in a local variable and use it to set `Session.source`:

```ts
let underlyingSource: Source;
if (runtimeProvider.includes("copilot")) {
  underlyingSource = "copilot-cli";
  // ... existing copilot reading code
} else if (engine.includes("codex") || runtimeProvider.includes("codex")) {
  underlyingSource = "codex";
  // ... existing codex reading code
} else {
  underlyingSource = "claude-code";
  // ... existing cc reading code
}

// later:
const session: Session = {
  // ...
  source: underlyingSource,            // was: "eureka"
  orchestrator: { kind: "eureka" },    // unchanged
  // ...
};
```

**Edge case:** when `meta.sdkSessionId` is missing, we have no underlying agent log. Use a best-effort inference from `runtimeProvider`/`engine` (the same hints we use to choose the SDK reader), and only fall back to `"claude-code"` as the last resort. Mark `tokenProvenance: "none"` regardless. This keeps source filters meaningful even when token data is absent.

```ts
function inferSourceFromHints(runtimeProvider?: string, engine?: string): Source {
  const rp = (runtimeProvider ?? "").toLowerCase();
  const en = (engine ?? "").toLowerCase();
  if (rp.includes("copilot")) return "copilot-cli";
  if (en.includes("codex") || rp.includes("codex")) return "codex";
  return "claude-code";
}
```

### Source resolver (`src/core/source-resolver.ts`)

Currently uses `session.source === "eureka"` to decide which path to look up. Switch to `session.orchestrator?.kind === "eureka"`.

### Aggregation (`src/core/aggregate.ts`)

Already supports `orchestrator` filter. Just verify:
- `orchestrator: "none"` → sessions with no orchestrator field
- `orchestrator: "eureka"` → sessions with `orchestrator.kind === "eureka"`
- `orchestrator: "mars"` → sessions with `orchestrator.kind === "mars"`

No code change needed here, but **add tests**: ensure source filter (`type: Source`) and orchestrator filter combine correctly.

### Server (`src/server/index.ts`)

Add backward-compat for old `source=eureka` and `source=mars` queries:

```ts
// In query parsing
const rawSource = req.query.source;
let source = rawSource;
let orchestrator = req.query.orchestrator;
if (rawSource === "eureka" || rawSource === "mars") {
  // Legacy: treat as orchestrator filter
  orchestrator = rawSource;
  source = undefined;
}
```

Note: the server today doesn't actually filter by `source` (filtering happens client-side in App.tsx). So this compat shim is mostly defensive for future API consumers.

### UI (`src/web/App.tsx`)

#### Filter state
Replace single `sourceFilter: AgentFilter` with two independent filters:

```ts
type SourceFilter = "all" | Source;                    // claude-code/codex/copilot-cli
type OrchestratorFilter = "all" | "none" | OrchestratorKind;  // none = direct (no orchestrator)

const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
const [orchestratorFilter, setOrchestratorFilter] = useState<OrchestratorFilter>("all");
```

#### Filter logic
```ts
const sourceSessions = useMemo(() => {
  let result = data?.sessions ?? [];
  if (sourceFilter !== "all") result = result.filter(s => s.source === sourceFilter);
  if (orchestratorFilter !== "all") {
    if (orchestratorFilter === "none") result = result.filter(s => !s.orchestrator);
    else result = result.filter(s => s.orchestrator?.kind === orchestratorFilter);
  }
  if (machineFilter !== "all") result = result.filter(s => s.machineId === machineFilter);
  return result;
}, [data, sourceFilter, orchestratorFilter, machineFilter]);
```

#### Chart stacking toggle
`buildChartData` takes a new `stackBy: "source" | "orchestrator"` parameter:

```ts
function buildChartData(sessions, stackBy: "source" | "orchestrator" = "source") {
  // group key per row:
  const key = stackBy === "source"
    ? session.source
    : (session.orchestrator?.kind ?? "direct");
  // ...
}
```

Add a small UI control near the chart title to toggle.

#### Filter dropdowns
Two dropdowns (icons + labels):
- Source: `All / Claude Code / Codex / Copilot CLI`
- Orchestrator: `All / Direct / Eureka / Mars`

Only show options that exist in current data (mirror the existing `availableSources` derivation).

**Reset / dependent state:**
- Both `sourceFilter` and `orchestratorFilter` participate in the `useEffect` that validates `selectedProject` against the filtered project set (App.tsx:206-211). Apply the same pattern: on either filter change, if the currently selected project no longer exists in `sourceProjects`, clear it.
- `modelFilter` follows the same pattern.

**ActiveFiltersBar chips:**
- Today renders a single "Agent: <label>" chip. Replace with up to two chips: "Source: <label>" and "Orchestrator: <label>" (only render the chip when the corresponding filter is not `"all"`).
- Each chip clears its own filter on dismiss.

**"Cost by Agent" panel:**
- Keep grouping by `source` for now (panel name is "Cost by Agent" but it actually shows underlying agent — that's fine).
- The panel's selectedName highlight reads from `sourceFilter` (not `orchestratorFilter`).
- Out-of-scope follow-up: add a parallel "Cost by Orchestrator" panel.

#### Color assignment
The existing color palette has 4 slots used for sources. With shrinking from 5 to 3 sources we'll have one extra color available — repurpose for orchestrator stacking:

- **Source stacking colors**: `claude-code = #18181b`, `codex = #3f3f46`, `copilot-cli = #71717a` (existing zinc ramp)
- **Orchestrator stacking colors**: `direct = #71717a`, `eureka = #2563eb`, `mars = #dc2626` (existing eureka blue + new mars red)

### Other surfaces

- `buildAgentData` / "Cost by Agent" panel: keep grouping by `source` for now (it already shows the correct underlying agent). Optionally add an "by orchestrator" toggle in a follow-up — out of scope here.
- `buildSessionsSubtitle`: include both filters when active.
- `AGENT_FILTER_LABELS`: split into `SOURCE_LABELS` and `ORCHESTRATOR_LABELS`.

## File Structure / Files Touched

| File | Change |
|------|--------|
| `src/core/types.ts` | Shrink `Source` to underlying agents; add `SourceType = Source \| OrchestratorKind`; widen `SourceEntry.type` and `Parser.source` to `SourceType` |
| `src/parsers/eureka.ts` | Capture branch into `underlyingSource`; set on Session.source; `inferSourceFromHints` for missing-sdk fallback; keep `orchestrator: { kind: "eureka" }` |
| `src/core/source-resolver.ts` | Switch eureka path lookup from `source === "eureka"` to `orchestrator?.kind === "eureka"` |
| `src/core/data.ts` | Add `normalizeLegacySources(machine)` + `inferSourceFromEngine` + `pickFresher`; persist after migration if any keys changed |
| `src/core/config.ts` (`loadMachineDataFromPath`) | Call `normalizeLegacySources` on load |
| `src/server/index.ts` | (a) Switch message replay dispatch from `session.source === "eureka"` to `session.orchestrator?.kind === "eureka"`; (b) add legacy `?source=eureka/mars` → `?orchestrator=...` shim |
| `src/web/App.tsx` | Two filters (sourceFilter + orchestratorFilter); independent reset logic; pass `stackBy` to TokenChart; ActiveFiltersBar wiring |
| `src/web/components/ActiveFiltersBar.tsx` | Render up to two chips (source + orchestrator) instead of one "Agent" chip |
| `src/web/App.tsx` `buildChartData` | Add `stackBy: "source" \| "orchestrator"` parameter |
| `src/web/components/TokenChart.tsx` | (only if needed for legend label changes — likely no change) |
| `tests/unit/eureka.test.ts`, `eureka-token-provenance.test.ts`, `eureka-copilot-sdk.test.ts`, `build-attribution.test.ts`, `session-messages-api.test.ts`, `aggregate.test.ts`, `source-resolver.test.ts` | Update assertions: `source === "eureka"` → `orchestrator.kind === "eureka"` and verify underlying `source` per branch |
| `tests/unit/eureka-parser.test.ts` (NEW) | Source attribution per SDK branch + missing-sdk fallback (4+ cases) |
| `tests/unit/legacy-source-migration.test.ts` (NEW) | Migration / key rewrite / collision / idempotent (4 cases) |
| `tests/unit/server-message-dispatch.test.ts` (NEW) or extend `session-messages-api.test.ts` | Replay parser dispatch by orchestrator + source (3 cases) |
| `tests/unit/server-legacy-query.test.ts` (NEW) | Legacy `?source=eureka/mars` query shim (2 cases) |
| `tests/e2e/eureka-attribution.test.ts` (NEW) | Full collect→API pipeline E2E |
| `tests/e2e/legacy-data-load.test.ts` (NEW) | Load+migrate+save+reload idempotency E2E |

## Backward Compatibility & Migration

### Persisted data (`~/.tokmon/machines/<machine>.json`)

**Critical context:** Sessions are stored in `MachineData.sessions` keyed by `${machineId}:${session.source}:${session.id}` (see `src/core/data.ts` `getSessionKey`). The Eureka parser uses cursor-based incremental parsing — unchanged sessions are NOT re-emitted on subsequent collects (`src/parsers/eureka.ts` skips files when inode/size/mtime match).

This means **two problems** if we just change `Session.source` going forward:
1. Old records with key `<m>:eureka:<id>` will never be overwritten by new ones with key `<m>:claude-code:<id>` → duplicates
2. Old records may never be re-emitted at all (cursor hit) → they keep `source: "eureka"` forever

**Solution: load-time normalization with key rewrite.**

In `loadMachineDataFromPath` (or a new helper called after load), normalize legacy entries:

```ts
function normalizeLegacySources(machine: MachineData): MachineData {
  const fixed: Record<string, Session> = {};
  for (const [oldKey, session] of Object.entries(machine.sessions)) {
    const s = session as Session & { source: string };
    if (s.source === "eureka") {
      // Infer underlying agent from existing engine label.
      const newSource = inferSourceFromEngine(s.engine ?? "");
      const migrated: Session = {
        ...s,
        source: newSource,
        orchestrator: s.orchestrator ?? { kind: "eureka" },
      };
      const newKey = getSessionKey(machine.machineId, migrated);
      // If a real new-key entry already exists (re-collect happened first),
      // merge: prefer the entry with non-zero cost / newer modifiedAt; tag
      // both as orchestrator: eureka.
      if (fixed[newKey]) {
        fixed[newKey] = pickFresher(fixed[newKey], migrated);
      } else {
        fixed[newKey] = migrated;
      }
    } else {
      // Non-eureka entries: pass through, but if a parallel migrated entry
      // arrived first, keep the fresher record.
      const key = getSessionKey(machine.machineId, s);
      fixed[key] = fixed[key] ? pickFresher(fixed[key], s) : s;
    }
  }
  return { ...machine, sessions: fixed };
}

function inferSourceFromEngine(engine: string): Source {
  const e = engine.toLowerCase();
  if (e.includes("copilot")) return "copilot-cli";
  if (e.includes("codex")) return "codex";
  return "claude-code"; // includes "Eureka + CC" and unknown
}

function pickFresher(a: Session, b: Session): Session {
  // Prefer non-zero cost; then newer modifiedAt; then b (latest write).
  const aCost = a.cost.total, bCost = b.cost.total;
  if (aCost > 0 && bCost === 0) return a;
  if (bCost > 0 && aCost === 0) return b;
  return new Date(b.modifiedAt).getTime() >= new Date(a.modifiedAt).getTime() ? b : a;
}
```

**Idempotent.** On the next save, the rewritten `MachineData.sessions` has only new-style keys; subsequent loads find no `source: "eureka"` to migrate.

**Save trigger.** The migration runs on every load, but the migrated structure is only persisted when something else triggers a `saveMachineData` call (next collect, manual save, etc.). For one-time forced migration we add a `saveMachineData(migratedData)` call in `loadMachineData` whenever the migration actually changed any keys, gated by an env flag or just unconditional if the migration touched anything.

### Message replay parser dispatch (`src/server/index.ts`)

Currently dispatches based on `session.source`:

```ts
session.source === "eureka" ? parseEurekaMessagesDetailed : ...
```

After migration `session.source` is no longer `"eureka"`. Switch dispatch to use `orchestrator?.kind === "eureka"` (preserves existing UX — Eureka sessions still replay from `session.jsonl`). Keep the existing branch-specific invocation pattern to avoid type-erasing the parser signature differences (`parseCopilotCliMessagesDetailed(path, id)` vs others):

```ts
let result;
if (session.source === "copilot-cli") {
  result = await parseCopilotCliMessagesDetailed(sourcePath, session.id);
} else if (session.orchestrator?.kind === "eureka") {
  result = await parseEurekaMessagesDetailed(sourcePath);
} else if (session.source === "codex") {
  result = await parseCodexMessagesDetailed(sourcePath);
} else {
  result = await parseClaudeCodeMessagesDetailed(sourcePath);
}
```

(For Mars-orchestrated sessions, `session.source` is the underlying agent and the existing dispatch correctly picks the cc/codex/copilot parser — no change needed for Mars replay.)

### `SourceEntry.type` config compatibility

`SourceEntry.type` widens from `Source` to `SourceType` (which still includes `"eureka"` and `"mars"`). Existing user config files with `type: "eureka"` or `type: "mars"` continue to validate. No config migration needed.

### `Parser.source` widening

`eurekaParser.source = "eureka"` and `marsParser.source = "mars"` are still valid because `Parser.source: SourceType`. SSE labels and progress events are unaffected.

### API queries

Legacy `?source=eureka` and `?source=mars` queries: server translates to `?orchestrator=...` before passing to `aggregateData`:

```ts
const rawSource = req.query.source as string | undefined;
const legacyOrchestrator = rawSource === "eureka" || rawSource === "mars" ? rawSource : undefined;
const orchestrator = req.query.orchestrator as string | undefined ?? legacyOrchestrator;
```

(Note: today the server does not actually pass a `source` filter to `aggregateData` — filtering happens client-side. This shim is defensive for future API consumers and to keep documented query params working. If both are present, explicit `orchestrator=` takes precedence over the legacy `source=` shim.)

### Web UI URL state

If the existing UI persists `sourceFilter` in URL/localStorage with values `eureka` or `mars`, translate them into the new dual-filter state on hydration:
- `eureka` → `sourceFilter: "all", orchestratorFilter: "eureka"`
- `mars` → `sourceFilter: "all", orchestratorFilter: "mars"`

## Edge Cases

1. **Eureka session with no `sdkSessionId`** → no underlying agent log; `source` is inferred via `inferSourceFromHints(runtimeProvider, engine)` (copilot/codex/cc), defaulting to `"claude-code"`. `tokenProvenance = "none"`.
2. **Eureka + Mars combined** (Mars-orchestrated session writing into Eureka workspace): currently impossible per architecture (Mars is its own orchestrator). If it ever happens, `orchestrator.kind` would be one or the other — no merging needed.
3. **Mars session without orchestrator metadata** (broken or partial parse): `source` stays as cc/codex/copilot, `orchestrator` undefined → falls under "direct" in orchestrator filter.
4. **User registers a source as `type: "mars"` or `"eureka"`**: allowed — `SourceType` includes both because `marsParser` and `eurekaParser` are real parsers and config entries. Only `Session.source` is constrained.
5. **Chart with only one orchestrator value present**: legend still shows it, but stacking with one series degenerates to a flat bar — that's fine.
6. **Backward compat collision**: if a future API consumer sends `source=eureka&orchestrator=mars`, the explicit `orchestrator=mars` wins. This is more intuitive than letting the legacy shim override an explicit filter.

## Test Strategy

### Unit tests (Vitest)

#### `tests/unit/eureka-parser.test.ts` (new)
- **Parser sets source = "claude-code" for Eureka session backed by CC jsonl**
  - Fixture: workspace dir with a session whose `sdkSessionId` resolves to a CC jsonl
  - Assert: `session.source === "claude-code"` and `session.orchestrator.kind === "eureka"`
- **Parser sets source = "copilot-cli" for Eureka session backed by Copilot events**
  - Fixture: workspace with `runtimeProvider: "copilot-cli"`
- **Parser sets source = "codex" for Eureka session backed by Codex rollout**
- **Parser infers source from runtimeProvider when sdkSessionId missing** (3 sub-cases: copilot/codex/cc), with `tokenProvenance: "none"` and `orchestrator.kind === "eureka"`
- **CC parser still skips eureka-claimed sessionIds** (regression check for dedup)

#### `tests/unit/aggregate.test.ts` (extend)
- **Filter by orchestrator + source combine correctly**
  - Mixed dataset with cc-direct, cc-eureka, cc-mars, codex-eureka
  - Filter `source: "claude-code", orchestrator: "eureka"` → only cc-eureka sessions
  - Filter `source: "claude-code", orchestrator: "none"` → only cc-direct
  - Filter `source: "all", orchestrator: "mars"` → cc-mars
- **Sum invariant**: total of all sessions = sum across any single dimension's groups

#### `tests/unit/source-resolver.test.ts` (extend existing)
- Old assertion: eureka path resolution by source. Update to check it works via `orchestrator.kind === "eureka"`.

#### `tests/unit/legacy-source-migration.test.ts` (new)
- **Legacy machine data with `source: "eureka"` is normalized on load**
  - Old session keyed `m1:eureka:abc` → migrated to `m1:claude-code:abc` (or copilot-cli/codex per engine label) with `orchestrator: { kind: "eureka" }`
  - Assert: old key absent, new key present, `Session.source` matches inferred underlying
- **Engine inference: cc / codex / copilot / unknown → claude-code**
- **Idempotent**: running migration on already-migrated data is a no-op
- **Collision handling**: pre-existing new-style key + legacy key for same `id` → merged via `pickFresher`, only one entry survives, takes non-zero cost / newer modifiedAt
- **Mars sessions untouched**: legacy data with `source: "claude-code", orchestrator: { kind: "mars" }` passes through unchanged

#### `tests/unit/server-message-dispatch.test.ts` (new) or extend `tests/unit/session-messages-api.test.ts`
- **Eureka session (post-migration: source=claude-code, orchestrator=eureka) routes to parseEurekaMessagesDetailed**
- **Mars session (source=claude-code, orchestrator=mars) routes to parseClaudeCodeMessagesDetailed**
- **Direct claude-code session routes to parseClaudeCodeMessagesDetailed**

#### `tests/unit/server-legacy-query.test.ts` (new)
- **Legacy `?source=eureka` rewrites to `?orchestrator=eureka` and returns same data**
- **Legacy `?source=mars` rewrites to `?orchestrator=mars`**

### E2E tests

#### `tests/e2e/eureka-attribution.test.ts` (new)
- **Full collect → API → chart data pipeline**
  - Set up a fake `~/.tokmon/machines` directory with a real eureka workspace fixture
  - Run `collectCommand`
  - Hit `/api/data?days=7`
  - Assert: response has eureka sessions with `source: "claude-code"` (not "eureka") and `orchestrator.kind === "eureka"`
  - Assert: aggregating by source shows cost in claude-code bucket; aggregating by orchestrator shows cost in eureka bucket; totals match

#### `tests/e2e/legacy-data-load.test.ts` (new)
- **Old machine data file with `source: "eureka"` is loaded, migrated, and persisted**
  - Seed `~/.tokmon/machines/<machineId>.json` with legacy entries
  - Trigger load via `loadMachineData`
  - Assert: in-memory `MachineData.sessions` keys all use new-style format
  - Save and reload → keys still new-style (idempotent)

#### Browser-level UI smoke (Playwright, optional / manual)
- Default view: source stacking shows cc/codex/copilot bars (no eureka segment)
- Toggle "stack by orchestrator": shows direct/eureka/mars segments
- Source filter + Orchestrator filter combine without conflict
- ActiveFiltersBar shows two chips when both filters non-default

### Existing corpus / fixture tests
- All existing tests (`tsc -b` clean + 151 tests pass) must continue passing.
- Pay specific attention to: `eureka.test.ts`, `eureka-token-provenance.test.ts`, `eureka-copilot-sdk.test.ts`, `build-attribution.test.ts`, `session-messages-api.test.ts`, `aggregate.test.ts`, `source-resolver.test.ts`. Update assertions where they hardcode `source === "eureka"` to instead check `orchestrator.kind === "eureka"`.

### Edge case tests
- Empty data (no sessions) → both filters show only "All" option
- Only orchestrator-less sessions → orchestrator filter shows "All" + "Direct"
- Source `"eureka"` query param → server translates and result matches `?orchestrator=eureka`

## Acceptance Criteria

1. ✅ `Session.source` only emits `claude-code` / `codex` / `copilot-cli` after this change
2. ✅ Eureka sessions have `orchestrator: { kind: "eureka" }` and a meaningful `source` (not "eureka")
3. ✅ "All agents" view stacked chart shows Eureka cost distributed across cc/codex/copilot segments (no longer a separate eureka segment)
4. ✅ New "by orchestrator" stacking toggle shows direct/eureka/mars segments
5. ✅ Source dropdown shows only underlying agent options; Orchestrator dropdown is independent
6. ✅ Legacy `?source=eureka` API query still works (returns same data as `?orchestrator=eureka`)
7. ✅ All 151 existing tests pass
8. ✅ New tests pass: parser source attribution (4 cases), filter combinations (3 cases), legacy normalization (1 case), E2E pipeline (1 case)
9. ✅ `tsc -b` clean
10. ✅ No double-counting (cc parser still skips eureka-claimed sessionIds)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Type narrowing breaks 15+ call sites | TS compiler surfaces them all; mechanical fix per site |
| User confusion: "Where did Eureka go in my chart?" | Default UI behavior: show source stacking; add changelog entry; orchestrator toggle visible |
| Legacy persisted data with old `source: "eureka"` | Normalize on load (one-time, idempotent) |
| Cursor cache stale | Migration handles it: load-time normalization rewrites legacy keys + Session.source even when cursor prevents re-emission |
| Color palette feels off (one fewer source color) | Repurpose freed slot for orchestrator dimension |

## Implementation Order

1. **Types** (`types.ts`) — shrink `Source`, add `SourceType`. Compile errors will guide subsequent steps.
2. **Eureka parser** — capture branch into `underlyingSource`, set on session.
3. **Source resolver** — switch to `orchestrator?.kind`.
4. **Aggregate / server** — verify filters; add legacy shim.
5. **Migration normalizer** — defensive load-time fix-up.
6. **UI: filters** — split into Source + Orchestrator dropdowns.
7. **UI: chart stacking toggle** — `buildChartData(sessions, stackBy)`.
8. **Tests** — write unit + E2E per Test Strategy.
9. **Run all tests, `tsc -b`, smoke-test in browser**.

## Out-of-Scope Follow-ups (not done here)

- "Cost by Orchestrator" panel (parallel to "Cost by Agent")
- URL state persistence for the new filters
- Mars task title drilldown in Source view
- Update `engine` label rules now that source/orchestrator are separate
