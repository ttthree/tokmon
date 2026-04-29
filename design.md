# Design: Attribute Token Consumption by Request Time

## Goals

Token and cost time series should reflect when model requests actually happened, not when the containing session started. Long-running sessions currently cause a past day to keep growing as new requests are appended. This design adds request-level usage events while preserving session-level views and backwards compatibility with existing machine data.

## Scope

### In scope

- Add a request-level usage event model to persisted `Session` data.
- Populate usage events from Claude Code and Codex logs, including Eureka fallback paths that read embedded SDK logs.
- Calculate cost at the usage-event level, then sum event costs back to the session.
- Add core aggregation helpers that can bucket usage by event time and filter session usage to a time window.
- Update dashboard time-series views to bucket token/cost values by request time.
- Keep existing session tables, project totals, source/orchestrator filters, and compatibility with older data files.
- Add unit and E2E/integration tests for cross-day long sessions and legacy fallback behavior.

### Out of scope

- Changing the meaning of `Session.createdAt` or `Session.modifiedAt`.
- Splitting a stored session into multiple sessions.
- Re-parsing historical data automatically outside the normal collect flow.
- Using Eureka headers or telemetry for Anthropic token data.
- Reworking the chart visual design or adding new UI controls.

## Problem

The current aggregate path uses `session.createdAt` for date filters and chart buckets:

- `src/core/aggregate.ts` filters ranges by `createdAt`.
- `src/web/App.tsx` builds chart buckets from `createdAt`.
- `ProjectTimeline`, `ProjectActivityTable`, and `BurnClock` also bucket by `createdAt`.

For sessions that remain open over many hours or days, each new assistant request increases the total cost attributed to the session's first day. This is especially visible on daily charts where yesterday's cost can keep rising today.

## Data Model

Add a usage event type to `src/core/types.ts`:

```ts
export interface UsageEvent {
  at: string;
  model: string;
  tokens: TokenBreakdown;
  cost?: CostBreakdown;
  requestId?: string;
}

export interface Session {
  // existing fields unchanged
  usageEvents?: UsageEvent[];
}
```

Rules:

- `usageEvents` is optional for backwards compatibility.
- `at` is the timestamp of the individual request/usage record.
- `model` is the model used for that request, or the session fallback model when unavailable.
- `tokens` uses tokmon's existing net-input semantics: input excludes cached input; cache read/write are separate.
- `cost` is populated during enrichment, not by parsers.
- `requestId` is optional and used only for parser-local dedupe/debugging; it must not contain prompt text or file paths.
- Session-level `tokens`, `cost`, and `modelUsage` remain available for existing UI and summaries.

## Parser Design

### Claude Code parser

In `src/parsers/claude-code.ts`, create a usage event for every `assistant` line with non-zero usage:

- Event timestamp: `envelope.timestamp` when parseable.
- Fallback timestamp: session file `entry.modified`/mtime only if the request timestamp is missing.
- Event model: per-line `message.model`/`model` from `extractEnvelopeModel`; fallback to `unknown` if unavailable.
- Event tokens: existing `usageToBreakdown` result.
- Event request id: `message.id` when present, otherwise a stable file/line fallback such as `${sessionId}:${lineNo}`.

Deduplication: Claude Code 2.1.114 can repeat the same assistant `message.id` with identical usage while splitting content. Maintain a parser-local set keyed by `message.id + model + token breakdown`; if the same key appears again in the same JSONL file, count it only once for `tokens`, `modelUsage`, and `usageEvents`. If a repeated `message.id` has different token values, keep it as a separate event because it may represent a distinct request/retry.

The parser continues to aggregate `tokens` and `modelUsage` as today, but derives them from the same per-line values as the events.

### Codex parser

Codex rollout logs emit `total_token_usage` as cumulative totals. In `src/parsers/codex.ts`:

- Track the current model from `turn_context` payloads, as Eureka fallback already does.
- For each `token_count` event, diff the current `total_token_usage` against the previous total.
- Convert the delta with existing Codex semantics: `input = input_tokens - cached_input_tokens`, `cacheRead = cached_input_tokens`.
- Emit one usage event at that `token_count` line's top-level `timestamp`.
- Event model: current `turn_context.payload.model`; fallback to the thread model built from SQLite row fields; final fallback `unknown`.
- Event request id: `${threadId}:${lineNo}` or equivalent stable file/line id.
- Preserve final aggregate tokens as the sum of deltas.

If a rollout lacks per-line timestamps, fall back to the thread `updated_at` only for events that have usage.

### Eureka fallback readers

In `src/parsers/eureka-fallback.ts`, extend `SdkTokenResult` with `usageEvents?: UsageEvent[]` and populate events in:

- `accumulateCcJsonl` for Claude Code SDK JSONL files.
- `extractCodexTurnModelUsage` for embedded Codex rollouts.
- `readCopilotSdkSessionTokens` when event-level usage is present.

Fallback contract:

- Embedded Claude Code: same event timestamp/model/requestId/dedupe rules as the primary Claude parser.
- Embedded Codex: same cumulative-delta rules as the primary Codex parser, using top-level line `timestamp` and current `turn_context.payload.model`.
- Copilot SDK event usage: use the event line's top-level `timestamp` if present; otherwise omit event-level attribution and keep aggregate tokens only. Model is the explicit model metric key when available, else the fallback model passed into the reader.
- Shutdown-only Copilot metrics have no request timestamp, so emit no request-level events and allow enrichment to synthesize a legacy session-level fallback event.

### Eureka attribution layer

In `src/core/attribute.ts`, copy fallback `usageEvents` onto the attributed Eureka session when available. Orphan/zero-token sessions may omit `usageEvents`.

## Enrichment and Cost

Add helpers in `src/core/usage-events.ts`:

```ts
export function getSessionUsageEvents(session: Session): UsageEvent[];
export function sumUsageEvents(events: UsageEvent[]): { tokens: TokenBreakdown; cost: CostBreakdown };
export function filterUsageEventsByWindow(events: UsageEvent[], start?: Date, end?: Date): UsageEvent[];
export function bucketUsageEventsByDay(events: UsageEvent[]): Map<string, UsageBucket>;
```

`getSessionUsageEvents` returns real events when present. Otherwise it returns a single synthetic event using `session.createdAt`, `session.model`, `session.tokens`, and `session.cost`. This keeps legacy data working.

Helper contracts:

```ts
interface UsageBucket {
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  sessions: Set<string>;
}

interface WindowedSessionUsage {
  events: UsageEvent[];
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  modelUsage: Record<string, TokenBreakdown>;
}
```

`getSessionUsageForWindow(session, start?, end?)` returns a `WindowedSessionUsage`; `windowSessionUsage(session, start?, end?)` returns a shallow `Session` clone or `null` when the date window has no matching events.

Update `src/core/enrich.ts`:

1. Build events from `session.usageEvents` or synthesize one from the session aggregate.
2. For every event, call `calculateSessionCost(new Date(event.at), event.tokens, event.model, session.source)`.
3. Sum event costs into `session.cost`.
4. Sum event tokens into `session.tokens` so parser aggregates and event aggregates stay consistent.
5. Rebuild `modelUsage` from events when real events exist.

This keeps all parser costs at zero and preserves the existing pricing source of truth.

## Aggregation Design

Keep session filtering by project, source, machine, and orchestrator unchanged. Change time-window filters to use usage events:

- A session matches a time range if at least one usage event falls within `[start, end)`.
- For aggregate totals inside a time range, count only events in the range.
- When `aggregateData()` is called with a date range, return **windowed session clones** in `DataResponse.sessions`: session metadata stays intact, but `usageEvents`, `tokens`, `cost`, and `modelUsage` are restricted/recomputed to the selected event window. This prevents web-only filters and charts from accidentally using out-of-range events from a long session.
- When no date range is active, return full sessions with full usage events.
- For `sessions` count in totals and project summaries, count distinct sessions with in-range usage.
- For `turns` and `durationSeconds`, keep session-level values for included sessions; do not attempt partial turn/duration attribution.
- For active days, use usage event dates, not session start dates.
- For breakdowns by source, model, machine, and orchestrator, sum in-range event cost but count distinct sessions per group.

Implementation approach:

- Add `getSessionUsageForWindow(session, start?, end?)` helper returning events plus summed tokens/cost.
- Add `windowSessionUsage(session, start?, end?)` helper that returns `null` when no event matches, otherwise returns a shallow session clone with windowed `usageEvents`, `tokens`, `cost`, and `modelUsage`.
- Update `applyFilters` and `applyComparisonFilters` to call `windowSessionUsage` after non-time filters; downstream `computeTotals`, `computeActiveDays`, `buildBreakdownItems`, and `computeProjectSummary` can then operate on already-windowed sessions.
- Preserve all-range behavior for legacy sessions through synthetic fallback events.

Persistence/merge note: `src/core/data.ts` session merge paths must preserve `usageEvents` from the fresher/highest-provenance session. Existing timestamp/source migrations should leave `usageEvents` untouched.

Cursor/migration policy: adding `usageEvents` is a schema-level parser output change. Add a parser schema version constant, for example in `src/core/cursor.ts` or parser context, and include it in cursor validation. When the version changes, existing file cursors are considered stale so normal `tokmon collect` re-reads unchanged parser files and backfills `usageEvents`. This avoids requiring a manual cache clear and keeps old machine data compatible until collect runs.

## Web Dashboard Design

Update chart builders to consume request-time events:

- `buildChartData`: iterate each session's already-windowed usage events and bucket by `event.at`; stack cost by source/orchestrator from the parent session.
- `buildModelData`: sum event `cost.total` by `event.model`; fallback through synthetic events.
- `BurnClock`: bucket selected metric by event weekday/hour.
- `ProjectTimeline`: bucket project daily heatmap by usage event day; session count is the number of distinct sessions with usage that day.
- `ProjectActivityTable`: same daily event bucketing as `ProjectTimeline`.
- Client-side source/orchestrator/machine/project/model/search filters should recompute totals/projects from the windowed sessions returned by the API, not from original full-session totals.
- Model breakdown semantics: cost is summed from event `cost.total` by event model. Session counts in model breakdowns count distinct parent sessions per model, so one multi-model session may contribute to multiple model groups.

Session table ordering and display continue to use session `createdAt`/`modifiedAt`; this task changes consumption attribution, not session identity.

## Backwards Compatibility and Migration

- Existing machine JSON without `usageEvents` remains valid.
- Dashboard and aggregate helpers synthesize one event per legacy session.
- New collection runs persist real `usageEvents` for sources that can provide request timestamps.
- Privacy redaction should retain `usageEvents` because they contain only timestamps, model IDs, tokens, and calculated costs; no prompts or file paths.
- If future sync size becomes an issue, `usageEvents` can be compacted by day/model/source later, but this design keeps raw request granularity for correctness.

## Edge Cases

- Missing event timestamp: fallback to the best available session/file timestamp; do not drop token usage.
- Duplicate or zero Codex deltas: ignore zero/negative deltas to avoid double counting.
- Model changes within a session: event model preserves per-request attribution.
- Long session crossing midnight: events before and after midnight land on different days.
- Timezone: existing UI date formatting uses local `Date`; helpers should follow current behavior and not introduce UTC-only bucketing unless already used.
- Pricing snapshots: event-level cost uses each event's date, so sessions spanning pricing snapshot changes are calculated accurately.

## Acceptance Criteria

- A long session with requests on two days shows cost on both days rather than all cost on the session start day.
- Date range filters include only request usage inside the selected range.
- Session totals still equal the sum of all request events for that session.
- Cost by model uses request-level event cost, not proportional session-cost allocation.
- Existing legacy data with no `usageEvents` still renders and totals correctly.
- Eureka sessions backed by Claude Code or Codex logs inherit underlying request-time events.
- `npm run test:unit`, `npm run build`, and `npm link` pass before completion.

## Test Strategy

### Unit tests

- `usage-events` helper tests:
  - synthesizes fallback event for legacy sessions.
  - filters events with inclusive start and exclusive end.
  - sums tokens and costs across events.
  - buckets events by local day.
- `enrichSession` tests:
  - calculates and sums event-level costs.
  - rebuilds aggregate tokens and model usage from events.
  - preserves fallback behavior for sessions without events.
- `aggregate` tests:
  - a cross-day session contributes cost/tokens to the correct range.
  - active days come from usage events.
  - source/model/machine breakdowns count distinct sessions but sum in-range event cost.
- Parser tests:
  - Claude Code parser emits one usage event per assistant usage line.
  - Codex parser diffs cumulative `total_token_usage` into per-request events.
  - Eureka fallback copies SDK usage events into attributed sessions.

### E2E / integration tests

- Add or extend an E2E test that builds a temporary corpus with one long-running session starting on day 1 and a later request on day 2. After collect/aggregate, verify daily chart/project activity data attributes day-2 request cost to day 2.
- Add a legacy-data-load test case where sessions have no `usageEvents`; verify dashboard/API totals remain unchanged.

### Manual verification

1. Run `tokmon collect` on a real machine with at least one long-running session.
2. Run `tokmon serve` and open the dashboard.
3. Select a recent date range and inspect the cost chart and project heatmap.
4. Confirm costs appear on the days/hours when requests occurred, while the session table still shows the original session start time.
