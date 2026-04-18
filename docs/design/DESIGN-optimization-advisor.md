# tokmon Repositioning — Optimization Advisor

## Why this exists

Project analytics tells users **where spend is happening**.
Session review tells users **what happened**.

The third direction is what makes tokmon truly proactive:

> **"Given my historical sessions, how can I use coding agents more efficiently next time?"**

This is the step from dashboard to advisor.

## Target user

- Frequent coding-agent user who wants practical habits
- Team lead trying to reduce waste without micromanaging prompts
- Curious user asking "what good usage looks like"

## Core questions to answer

- Which patterns correlate with expensive sessions?
- Which projects or tools have poor cache reuse?
- When should I switch models or split sessions?
- Which sessions likely needed better scoping or batching?

## Product concept

tokmon should generate **actionable, evidence-backed suggestions** from observed metadata.

Important rule:

- Advice must cite measurable signals
- Advice should be phrased as suggestions, not judgments
- Users should see *why* a recommendation was made

## Recommendation categories

### 1. Session scoping

Examples:

- "Long sessions in `tokmon` average 42 turns and 4x the median cost. Consider splitting work into smaller tasks."
- "This project has many short sessions with repeated first prompts. Consider a reusable kickoff template."

Signals:

- duration
- turns
- repeated prompts/summaries
- cost outliers within a project

### 2. Model selection

Examples:

- "Most spend in the last 30 days came from `claude-sonnet` on low-tool sessions. A cheaper model may be enough for some work."
- "High-cost sessions on this machine cluster around one model family."

Signals:

- cost by model
- cost per turn by model
- model usage for low-complexity sessions

### 3. Cache efficiency

Examples:

- "Cache read rate is low for this project's repeated sessions; keeping work in fewer continuous sessions may improve reuse."
- "Large cache writes with little cache read suggest frequent context resets."

Signals:

- cache read vs cache write
- repeated sessions on same project
- short intervals between sessions

### 4. Tool usage efficiency

Examples:

- "Sessions using shell + grep heavily tend to be efficient, while long no-tool sessions are more expensive."
- "This workflow uses many turns before the first tool call; consider prompting for an explicit repo scan first."

Signals:

- tool call count
- tool diversity
- dominant tools
- early vs late tool usage (phase two, transcript-backed)

## Recommendation object

```ts
interface Recommendation {
  id: string;
  title: string;
  body: string;
  category: "scoping" | "model" | "cache" | "tooling";
  severity: "info" | "opportunity" | "high";
  confidence: number;
  evidence: Array<{
    label: string;
    value: string | number;
  }>;
  filters?: {
    project?: string;
    source?: string;
    model?: string;
    machine?: string;
  };
}
```

## How recommendations should be generated

### Phase 1 — Deterministic heuristics

Start with transparent rules over aggregated data:

- outlier detection vs project median
- cache hit rate thresholds
- high cost per turn thresholds
- repeated-session clustering by project and time window

Why start here:

- easy to test
- easy to explain
- no LLM dependency
- keeps user trust high

### Phase 2 — Pattern summaries

Once heuristics are stable, group them into weekly summaries:

- "3 patterns worth changing this week"
- "top savings opportunities"
- "projects trending inefficiently"

### Phase 3 — LLM-assisted narrative

Only after deterministic evidence is solid, optionally let an LLM rewrite recommendations into nicer natural language.

The LLM should never invent evidence; it only rewrites structured recommendations.

## UX proposal

### 1. Add an "Insights" section on the dashboard

Each insight card includes:

- title
- one-sentence recommendation
- evidence chips
- click action to apply filters and inspect relevant sessions

### 2. Add project-scoped recommendations

When filtering to one project, recommendations become project-specific.

This is more actionable than only showing global advice.

### 3. Add savings framing

Where possible, estimate impact:

- possible cost avoided per month
- sessions affected
- models involved

Keep it approximate and clearly labeled as an estimate.

## Architecture changes

- Add recommendation generation to `src/core/aggregate.ts` or a new `src/core/recommendations.ts`
- Return recommendations in `/api/data` or a dedicated `/api/insights`
- Reuse existing session metadata first; do not block on transcript support

## Rollout plan

### Phase 1 — 5 deterministic recommendations

Start with:

- high cost per turn
- low cache reuse
- expensive model concentration
- repeated short sessions on same project
- unusually long sessions

### Phase 2 — Better targeting

- per-project baselines
- machine-specific patterns
- source-specific heuristics

### Phase 3 — Weekly advisor mode

- generated weekly summary view
- trend-aware recommendations
- optional export/shareable report

## Non-goals

- Not automatic prompt rewriting
- Not autonomous optimization actions
- Not scoring developer quality
- Not pretending heuristic suggestions are certainty

## Success criteria

- Users can identify at least one concrete workflow improvement from the dashboard
- Every recommendation has visible evidence
- Recommendations increase trust in tokmon rather than feeling like generic AI advice

## Recommended next implementation

1. Create `src/core/recommendations.ts` with deterministic rules
2. Return recommendations from the API alongside totals and sessions
3. Add an Insights card list in `src/web/App.tsx`
4. Make each insight clickable to apply filters and inspect affected sessions
