# tokmon Repositioning — Project Cost Intelligence

## Why this exists

tokmon already does the hard infrastructure work well: it collects sessions across Claude Code, Codex CLI, Copilot CLI, and Eureka; normalizes token/cost data; and serves a dashboard.

What is still missing is a sharper product story.

The first and most immediately valuable story is:

> **"Help me understand which projects are consuming AI budget, on which tools, and whether that spend is trending up or down."**

This becomes tokmon's entry point: a lightweight finance + engineering observability tool for AI-assisted development.

## Target user

- Individual developer with multiple active repos
- Tech lead paying attention to team AI usage
- Founder / manager who wants quick answers without reading raw session logs

## Core questions to answer

- Which projects consumed the most AI spend this week / month?
- Which agent/tool is driving that spend?
- Is a project's cost rising because of more sessions, more expensive models, or longer conversations?
- Which machines or environments are contributing most?

## Product promise

tokmon should feel like:

- **fast to open** — one command to get the dashboard
- **trustworthy** — numbers reconcile to actual session data
- **project-first** — the main organizing unit is the repo / mapped project, not the raw session file
- **cross-tool** — one place for all coding-agent spend

## What already exists

Current code already supports most of the data foundation:

- Project mapping via `src/core/project.ts`
- Aggregated totals via `src/core/aggregate.ts`
- Session-level cost and token breakdowns in `src/core/types.ts`
- Dashboard charts in `src/web/App.tsx`
- Multi-machine aggregation through `src/sync/github.ts`

So this direction is mostly a **positioning and UX refocus**, not a data-platform rewrite.

## Proposed UX changes

### 1. Make the homepage explicitly project-centric

Current dashboard mixes overall totals with charts and a recent-session table. Reposition the top half around projects:

- Top card row keeps overall totals
- Primary chart becomes **project spend over time**
- Secondary chart shows **project share of total spend**
- Add a **project leaderboard** table with:
  - project name
  - total cost
  - total tokens
  - sessions
  - average cost per session
  - trend vs previous period

### 2. Add time comparison

For each project, compare:

- last 7d vs previous 7d
- last 30d vs previous 30d
- last 3m vs previous 3m

This turns raw totals into actionable signals.

### 3. Add "cost drivers" breakdown

When a project is selected, show:

- spend by source (`claude-code`, `codex`, etc.)
- spend by model
- token composition (`input`, `output`, `cache read`, `cache write`)
- top active machines

This answers "why is this project expensive?" without opening session details.

## New metrics

Add project-level derived metrics:

```ts
interface ProjectSummary {
  project: string;
  sessionCount: number;
  totalCost: number;
  totalTokens: number;
  totalTurns: number;
  avgCostPerSession: number;
  avgTurnsPerSession: number;
  activeDays: number;
  topSource: string;
  topModel: string;
  costTrendPct?: number;
}
```

## API shape changes

Extend `/api/data` or add `/api/projects` to return project summaries directly.

Preferred direction: keep aggregation server-side so the frontend stays simple.

```ts
interface ProjectsResponse {
  projects: ProjectSummary[];
  range: { currentStart: string; currentEnd: string; previousStart?: string; previousEnd?: string };
}
```

## Rollout plan

### Phase 1 — Better project summaries

- Add project summary aggregation in `src/core/aggregate.ts`
- Add leaderboard UI in `src/web/App.tsx`
- Add trend calculation for selected time windows

### Phase 2 — Project detail drill-down

- Click a project to filter the whole page
- Add source/model/machine breakdown cards
- Preserve current session table but scoped to the selected project

### Phase 3 — Project alerts

- Flag unusual cost spikes
- Flag newly expensive models
- Flag projects with heavy spend but low cache reuse

## Non-goals

- Not a team billing system
- Not invoice-grade accounting
- Not task-level attribution
- Not judging whether a project was "worth it" yet

## Success criteria

- A user can identify the most expensive project in under 10 seconds
- A user can explain a project's spend increase without leaving the dashboard
- The homepage communicates "project cost intelligence" even before reading documentation

## Recommended next implementation

1. Add server-side `ProjectSummary` aggregation
2. Replace one current chart with a project leaderboard/table
3. Add period-over-period trend calculation
4. Make project selection a first-class filter state
