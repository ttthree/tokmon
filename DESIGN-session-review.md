# tokmon Repositioning — Session Review Workspace

## Why this exists

Project-level spend answers **where money went**.

The second product direction answers:

> **"What actually happened inside a costly or important agent session?"**

Today tokmon exposes a flat recent-session table, but the real value is in turning it into a review workspace for past conversations.

## Target user

- Developer trying to remember how a bug was fixed
- Tech lead auditing how an agent was used on a project
- Power user comparing successful vs wasteful sessions

## Core questions to answer

- What was this session trying to do?
- How long did it run, and how much did it cost?
- Which tools were used heavily?
- Was the session exploratory, productive, or stuck?
- What should I reopen, reuse, or avoid next time?

## Existing foundation

Current data model already stores useful review primitives in `src/core/types.ts`:

- `summary`
- `firstPrompt`
- `toolBreakdown`
- `messageCount`
- `turns`
- `durationSeconds`
- token and cost breakdowns

So version one does **not** need full raw transcript rendering. It can provide a high-signal review page using already-collected metadata.

## Product concept

Turn each session row into an entry point for a detail panel or page.

### Session detail should show

- Header
  - project
  - source/tool
  - model
  - machine
  - start time
  - duration
  - total cost
- Intent
  - summary
  - first prompt
- Activity
  - turns
  - messages
  - tool calls
  - tool breakdown chart
- Cost anatomy
  - input/output/cache tokens
  - cost by token type
- Related context
  - nearby sessions in the same project
  - same-day sessions on the same machine

## UX proposal

### 1. Click-through session detail

From the session table, clicking a row opens a right-side drawer first.

Why drawer first:

- fast to implement
- preserves dashboard context
- works well for quick review

Later, add a dedicated route for deep links.

### 2. Add review tags

Compute lightweight tags from session metadata:

- `long-running`
- `high-cost`
- `tool-heavy`
- `many-turns`
- `cache-efficient`
- `low-context` (little prompt/summary available)

These help users scan for interesting sessions.

### 3. Add session comparison

Allow selecting two sessions and comparing:

- cost
- turns
- duration
- tool usage
- token mix

This is especially useful for "why was this fix expensive today but cheap yesterday?"

## Data/API additions

### Option A — metadata-only first release

No parser changes. Add a detail response assembled from the existing session object:

```ts
interface SessionDetailResponse {
  session: Session;
  reviewTags: string[];
  relatedSessions: Session[];
}
```

### Option B — transcript-backed second release

Add source-specific resolvers that can reopen local source files for richer detail.

Examples:

- Claude Code: reopen `.jsonl`
- Codex: fetch related messages from SQLite
- Copilot CLI: reconstruct from logs where available

That unlocks:

- message timeline
- tool call sequence
- richer excerpt previews

This should be phase two because cross-source transcript parity is harder.

## New derived signals

```ts
interface SessionReviewSignals {
  avgCostPerTurn: number;
  avgTokensPerTurn: number;
  dominantTool?: string;
  cacheHitRate: number;
  intensityScore: number;
}
```

`intensityScore` can be a normalized blend of turns, duration, and tool activity.

## Rollout plan

### Phase 1 — Session drawer

- Make rows clickable in `src/web/components/SessionTable.tsx`
- Add selected-session state in `src/web/App.tsx`
- Render metadata, token/cost breakdown, and tool chart

### Phase 2 — Better context

- Add related-session suggestions
- Add review tags and comparison mode
- Add URL state for deep-linking

### Phase 3 — Transcript drill-down

- Add backend endpoint per session
- Reopen raw source data when available locally
- Show timeline of prompts, assistant replies, and tool usage

## Non-goals

- Not full conversation replay across all tools on day one
- Not editing or annotating sessions yet
- Not collaborative review workflows yet

## Success criteria

- A user can open any session and understand its shape in under 15 seconds
- A user can explain why a session was expensive using the detail view alone
- Session review becomes a repeatable workflow, not just a static table

## Recommended next implementation

1. Add clickable session rows and detail drawer
2. Compute review tags client-side or server-side
3. Add related sessions by same project / nearby time
4. Delay transcript reconstruction until the metadata-first flow proves useful
