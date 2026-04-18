# tokmon Increment — Project Leaderboard Top 10 + Search

## Goal

Refine the project leaderboard UX:

1. Limit the leaderboard to the top 10 visible projects
2. Add a dedicated leaderboard search filter
3. Preserve the current selected project even if the leaderboard search filters it out

## In scope

- Add a leaderboard-only search input
- Filter leaderboard rows by project name using that input
- Limit displayed leaderboard rows to 10 after filtering
- Keep existing session search behavior unchanged
- Preserve selected-project state when leaderboard search hides the selected row
- Add/update targeted E2E coverage

## Out of scope

- Any changes to backend aggregation
- Any changes to session table search behavior
- Changing selected-project behavior for time-filter changes
- Changing project detail or chart behavior

## Product behavior

### Search separation

There are now two distinct searches:

- leaderboard search: filters only project leaderboard rows
- session search: filters only recent session rows

These two searches must not affect each other.

### Top 10 rule

Leaderboard rows should show at most 10 projects.

Rule:
- start from `data.projects`
- apply leaderboard search filter by `projectLabel` / `projectKey`
- take the first 10 rows from the already-sorted result

The existing server-side sorting remains the ranking source.

### Selected-project preservation

If a project is currently selected and the leaderboard search no longer matches it:

- keep `selectedProject` unchanged
- keep the project detail card visible
- keep selected-project charts and session scoping unchanged
- do not auto-clear selection

This means the detail panel can refer to a project that is not currently visible in the leaderboard rows.

### Empty leaderboard search state

If the leaderboard search returns no matches:

- show an empty state in the leaderboard area
- do not affect the selected-project detail card

## Implementation notes

- Add a dedicated state in `App.tsx`, e.g. `projectSearch`
- Derive `visibleProjects` with `useMemo`
- Pass filtered/top-10 projects into `ProjectLeaderboard`
- Keep `selectedProjectSummary` based on full `data.projects`, not filtered projects
- Add a small note/count in the leaderboard header if useful, but keep changes minimal

## Acceptance criteria

- leaderboard displays no more than 10 rows
- leaderboard search filters only leaderboard rows
- session search still filters only session rows
- selected project stays active when hidden by leaderboard search
- empty leaderboard search state does not clear selection
- tests and build pass
