# tokmon Phase 1 — Project Cost Intelligence

## Goal

Implement the first repositioning direction for tokmon: make the dashboard clearly project-centric so users can quickly understand which projects consume AI budget, how those projects are trending, and what is driving the spend.

This phase stays incremental. It builds on the existing collection, aggregation, and dashboard stack without changing parsers, sync format, or introducing transcript-level session detail.

## Scope

### In scope

- Add server-side project summary aggregation
- Add period-over-period project trend calculation based on the active time filter
- Add a project leaderboard UI on the dashboard
- Make project selection a first-class dashboard filter
- Add a selected-project detail section with driver breakdowns:
  - spend by source
  - spend by model
  - spend by machine
  - token mix
- Keep the existing recent session table, but scope it to the selected project when one is selected
- Keep the existing search box behavior within the recent-session table only
- Add unit tests for new aggregation logic
- Add E2E coverage for the project-centric dashboard workflow

### Out of scope

- Session drawer / transcript review
- Optimization recommendations / insights
- New CLI commands
- Changes to parser contracts or sync payloads
- Auth, multi-user dashboards, or team billing
- Persisting selected filters across runs or URL params

## Canonical project identity

Phase 1 uses the existing `session.project` string as the canonical project identity for aggregation, leaderboard rows, and frontend selection.

That means:

- backend groups by `session.project`
- frontend selection uses `selectedProject: string | null`
- project summaries expose both `projectKey` and `projectLabel`, but both are the same value in Phase 1

```ts
projectKey = session.project
projectLabel = session.project
```

This is an explicit Phase 1 tradeoff. It preserves the current normalization behavior from `resolveProject()` and avoids changing the session storage model.

Known limitation accepted in Phase 1:

- if two unrelated repos resolve to the same project name, they will be merged in project views

This is acceptable for the first implementation because tokmon already treats `project` as the normalized project dimension. A future phase can introduce a richer project identity model if needed.

## Product behavior

### Default dashboard behavior

When the dashboard loads:

- the top stat cards still show overall totals for the active time range
- the page prominently shows a **project leaderboard** ranked by total cost
- the page shows trend for each project relative to the previous equivalent period when trend is available
- no project is selected by default
- the dashboard clearly communicates that tokmon is project-first

### Selecting a project

Users can select a project from the leaderboard.

When a project is selected:

- the dashboard enters a project-focused state
- a visible selected-project control appears with a way to clear it
- the project detail section shows:
  - total cost
  - total sessions
  - total tokens
  - average cost per session
  - average turns per session
  - active days
  - trend percentage vs previous period when available
  - top source
  - top model
  - top machine
- the breakdown section switches to selected-project driver views:
  - cost by source
  - cost by model
  - cost by machine
- recent sessions table shows sessions for the selected project only
- search continues to filter only within the currently visible recent-session rows

### Search behavior

Search is scoped to the recent-session table only.

Search does **not** affect:

- top stat cards
- project leaderboard
- selected-project detail card
- charts / breakdowns

Reason: the dashboard should show stable project intelligence for the selected time range, while the search box remains a lightweight way to find sessions in the table.

### Time filters

Existing time filters continue to work:

- `all`
- `7d`
- `30d`
- `12m`

Trend logic behaves as follows:

- `7d` compares the last 7 days vs the preceding 7 days
- `30d` compares the last 30 days vs the preceding 30 days
- `12m` compares the rolling last 12 months vs the preceding rolling 12 months
- `all` does not have a previous-period comparison, so trend is omitted

### Selected-project behavior across time-filter changes

If the user changes the time filter:

- if the currently selected project still exists in the new response, keep it selected
- if the selected project no longer exists in the new response, automatically clear the selection

This avoids a confusing empty selected-project state for a project that is absent in the current range.

## Architecture

### Current state

Current `DataResponse` includes:

- `machines`
- `sessions`
- `totals`

The frontend derives project/model/source breakdowns client-side from raw sessions.

### Proposed state

Move project summary generation to the backend so the frontend renders directly from structured project summaries.

Extend the aggregate response with:

```ts
interface BreakdownItem {
  key: string;
  label: string;
  cost: number;
  sessions: number;
}

interface ProjectTrend {
  previousCost: number;
  delta: number;
  deltaPct?: number;
}

interface ProjectSummary {
  projectKey: string;
  projectLabel: string;
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
  totalTurns: number;
  avgCostPerSession: number;
  avgTurnsPerSession: number;
  activeDays: number;
  topSource?: string;
  topModel?: string;
  topMachine?: string;
  tokenBreakdown: TokenBreakdown;
  costBreakdown: CostBreakdown;
  sourceBreakdown: BreakdownItem[];
  modelBreakdown: BreakdownItem[];
  machineBreakdown: BreakdownItem[];
  trend?: ProjectTrend;
}

interface DataResponse {
  machines: MachineInfo[];
  sessions: Session[];
  totals: { ...existing fields... };
  projects: ProjectSummary[];
}
```

The frontend will continue using `sessions` for the recent-session table and search, but should use `projects` for the leaderboard and selected-project detail view.

## Data design

### Project summary aggregation

Add server-side helpers in `src/core/aggregate.ts`:

- `buildProjectSummaries(currentSessions, comparisonSessions)`
- `computeProjectSummary(projectKey, sessions, comparisonSessions)`
- `computeActiveDays(sessions)`
- `buildBreakdownItems(sessions, dimension)`
- `pickTopBreakdownItem(items)`

Project summaries should be sorted deterministically by:

1. `totalCost` descending
2. `sessionCount` descending
3. `projectLabel` ascending

### Breakdown semantics

For a project summary:

- `sourceBreakdown` groups by `session.source`
- `modelBreakdown` groups by `session.model`
- `machineBreakdown` groups by `session.machineId`
- `tokenBreakdown` is the token mix for the project and is used for the token-mix UI

Each breakdown array should be sorted deterministically by:

1. `cost` descending
2. `sessions` descending
3. `label` ascending

### Trend calculation

Trend is based on cost only in Phase 1.

For a given current range:

- determine the current-period session set using existing filters
- determine the previous-period session set using the equivalent preceding window
- for each project in the current period, compute:

```ts
trend.delta = currentCost - previousCost
trend.deltaPct = previousCost > 0 ? trend.delta / previousCost : undefined
```

Behavior when previous cost is zero:

- `previousCost = 0`
- `delta` is still computed
- `deltaPct` is omitted to avoid misleading infinite growth

For `all`, omit `trend`

### Period boundary rules

Use rolling timestamp windows from `Date.now()`.

For all ranged filters:

- include a session when `createdAt >= rangeStart && createdAt < rangeEnd`
- `rangeEnd` is `Date.now()` for the current period
- the previous period is the immediately preceding adjacent window of equal duration

Specific rules:

- `7d`: 7 × 24 hours rolling window
- `30d`: 30 × 24 hours rolling window
- `12m`: use `Date#setMonth(now.getMonth() - 12)` for the start boundary, i.e. rolling 12 months from now, not calendar-year buckets

These same rules should be used in tests.

### Filtering model

Server API remains `/api/data`.

No new query params are required for Phase 1. The frontend can keep loading one response for the active range and filter the selected project client-side.

## UI design

### Dashboard layout changes

Update `src/web/App.tsx` to add a project-first section near the top of the page.

Recommended layout:

1. header + time filter (unchanged)
2. overall stat cards (unchanged)
3. **Project Intelligence** section:
   - left: project leaderboard table/list
   - right: selected-project detail card or empty state
4. breakdown section
   - if no project selected: existing global charts
   - if project selected: project driver charts
5. recent sessions table, scoped to selected project when selected

### Leaderboard requirements

Each row shows:

- project name
- total cost
- sessions
- average cost per session
- trend indicator when available

Interaction:

- clicking a row selects the project
- selected row has clear visual state
- include a clear-filter control in the detail card or section header

### Selected-project detail card

If no project is selected, show an empty state like:

- “Select a project to inspect cost drivers.”

If selected, show:

- project name
- trend badge/value when available
- total cost
- total sessions
- total tokens
- average cost per session
- average turns per session
- active days
- top source
- top model
- top machine
- token mix summary (either mini stats or a lightweight visual)

### Breakdown section behavior

If no project is selected, keep the existing global charts:

- cost by project
- cost by model
- cost by agent

If a project is selected, replace the global charts with exactly these project driver charts:

- cost by source
- cost by model
- cost by machine

Do **not** show a one-project “cost by project” chart in selected-project mode.

### Existing charts

Existing breakdown/chart components can be reused where reasonable.

The token chart at the top can remain range-level and does not need to change with search. It may remain global to the current time range even when a project is selected.

## File changes

Expected files to change:

- `design.md` — this doc
- `src/core/types.ts` — extend `DataResponse` and add `ProjectSummary`, `BreakdownItem`, `ProjectTrend`
- `src/core/aggregate.ts` — add project summary + trend logic
- `src/web/App.tsx` — add project-first state and layout
- `src/web/api.ts` — likely only type usage changes
- `src/web/components/` — add one or two focused components, likely:
  - `ProjectLeaderboard.tsx`
  - `ProjectDetailCard.tsx`
- `tests/unit/aggregate.test.ts` — add project summary tests
- `tests/e2e/dashboard.spec.ts` — add project selection + scoped view test
- `tests/helpers/fixtures.ts` — extend fixture data only if required for clear leaderboard and trend assertions

Avoid unnecessary refactoring of unrelated components.

## Edge cases

Must handle:

- empty dataset
- only one project in range
- project exists in current period but not previous period
- project has zero previous cost for comparison
- project selected in one range but absent in another range
- sessions with missing `summary` / `firstPrompt`
- very small costs (formatting should remain readable)
- ties in ordering must use the deterministic secondary sort keys defined above

## Acceptance criteria

### Functional

- dashboard shows a project leaderboard ranked by total cost
- leaderboard rows display cost, session count, avg cost/session, and trend when available
- clicking a leaderboard row filters the dashboard into a selected-project state
- selected-project detail view shows project summary and drivers
- selected-project mode shows source/model/machine driver charts
- recent sessions table is scoped to the selected project
- clearing the selection restores all-project view
- existing time filters continue to work
- `all` range omits trend gracefully
- search filters only the recent-session table
- selected project clears automatically if absent after a time-range change

### Quality

- no parser behavior changes
- no sync payload changes
- existing dashboard behavior outside the new project-centric features remains intact
- implementation stays incremental and readable

## Test Strategy

### Unit tests

Add targeted tests in `tests/unit/aggregate.test.ts` for:

1. `buildProjectSummaries` aggregates sessions by project correctly
2. summaries are sorted by total cost desc, then session count desc, then project label asc
3. `avgCostPerSession` and `avgTurnsPerSession` are correct
4. `activeDays` counts unique dates correctly
5. `topSource`, `topModel`, and `topMachine` are computed correctly
6. `sourceBreakdown`, `modelBreakdown`, and `machineBreakdown` are correct and deterministically sorted
7. trend calculation for `7d` or `30d` compares against previous equivalent period correctly using the documented rolling boundaries
8. trend omits `deltaPct` when previous cost is zero
9. `all` range omits trend
10. empty sessions returns an empty project summary list

### E2E tests

Extend `tests/e2e/dashboard.spec.ts` to cover the full user workflow:

1. load dashboard successfully
2. verify project leaderboard is visible
3. verify at least two distinct project rows exist in the fixture-backed view
4. click a project row
5. verify selected-project detail is visible
6. verify source/model/machine driver charts are visible in selected-project mode
7. verify session table now only shows that project's sessions
8. use the search box and verify it filters session rows only, not the leaderboard/header stats
9. clear the selected project
10. verify all-project view is restored
11. switch time range and verify selection is preserved only when the project still exists; otherwise it is cleared

If the existing fixture data is insufficient to verify leaderboard and selection clearly, extend `tests/helpers/fixtures.ts` minimally with at least two distinguishable projects and differing costs.

### Error and edge-path tests

- empty or minimal fixture still renders dashboard without crashing
- project with no previous-period data does not crash trend UI
- `all` range renders without trend values and without crashing
- time filter changes continue to fetch and render data

## Implementation notes

- prefer pure helper functions in `src/core/aggregate.ts` so they are easy to unit test
- keep frontend state simple: one `selectedProject: string | null`
- on data reload, if `selectedProject` is not found in `data.projects`, clear it in an effect
- reuse existing formatting helpers in `src/web/App.tsx` where possible
- keep added components presentational; avoid over-engineering
- do not add new dependencies

## Done definition

The feature is done when:

- code is implemented
- unit tests pass
- E2E dashboard tests pass
- reviewer confirms the implementation matches this design and does not add unnecessary scope
