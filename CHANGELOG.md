# Changelog

All notable changes to `@ttthree/tokmon` will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.8] – 2026-07-09

### Added
- Eureka PI runtime sessions are now tracked as `pi-agent` / `Eureka + Pi`
  sessions with token usage parsed from PI `.jsonl` session logs.
- Dashboard source filters and settings now include PI Agent as a first-class
  source.

### Fixed
- Prevent Eureka + Copilot sessions from being mislabeled as PI sessions.
- Deduplicate stale orchestrated-session keys when a Eureka/Mars session changes
  underlying source across releases.
- Deduplicate repeated PI SDK response usage across multiple `.pi` JSONL files.

## [0.2.7] – 2026-05-25

### Fixed
- Eureka sessions showing zero cost after the `.craft-agent` → `.eureka`
  directory rebrand. SDK JSONL lookup now searches both
  `~/.craft-agent/.claude` and `~/.eureka/.claude`.

## [0.2.6] – 2026-04-29

### Added
- Request-time `usageEvents` attribution for Claude Code, Codex, and
  Eureka fallback token sources, enabling long sessions to be counted on
  the days their model requests actually occurred.

### Changed
- Dashboard date filters, timelines, burn clock, project activity, and
  model-cost breakdowns now use request-level usage events instead of
  session start time.
- Corpus golden snapshots now include request-level token/cost events and
  updated aggregate totals.

### Fixed
- Parser cursor schema invalidation now forces unchanged files to be
  re-read after request-level attribution changes, backfilling event data
  without manual cache clearing.

## [0.2.1] – 2026-04-18

### Fixed
- **Eureka SDK token loss for dotted `sdkCwd`** — `encodeClaudeProjectPath()`
  now also replaces `.` with `-` (mirroring Claude Code's on-disk
  encoding). Previously, sessions whose `sdkCwd` contained a dotted
  segment (e.g. `.craft-agent/...`) silently logged 0 tokens / \$0 on
  incremental collects because the constructed CC jsonl path didn't
  exist on disk.
- Corpus golden generator (`parseAllPure`) now dedupes by
  `${source}:${id}` to mirror `collect()`'s keyed map. Without this,
  workspaces reachable from two overlapping eureka source paths (legacy
  `.craft-agent/workspaces` and new `.eureka/workspaces`) were
  double-counted in the goldens but not at runtime.
- `mars-e2e` test timeout bumped from 20s to 60s, and `fs.rm` cleanup
  now uses `maxRetries: 5, retryDelay: 100` to tolerate Windows
  file-handle locking.

## [0.2.0] – 2026-04-18

### Added
- **Machine filter** in the dashboard header (renders only when ≥2
  machines exist), threaded through session / totals / project filters.
- New shared `IconDropdown` portal-popover component used by the header
  filters and (now) the theme picker.
- `npm run dev:web` (Vite) and `npm run dev:all` (concurrent API + Vite)
  scripts for HMR'd development of the dashboard.
- Automated release workflow: merging a version-bump PR to `main`
  publishes to npm (with provenance), tags `v<version>`, and creates a
  matching GitHub Release.

### Changed
- Header collapses into a single `h-8` row: agent / machine / time
  selectors, tabs, and refresh share one bar; the standalone "Token
  Monitor" title is removed (the `TOKMON v0.x.y` eyebrow stays).
- `ThemePicker` migrated onto `IconDropdown`, removing ~140 lines of
  duplicated portal/menu code.

### Fixed
- `selectedProject` now resets against the *filtered* project set, so a
  project that disappears under the current agent/machine combination
  cannot silently keep narrowing the visible session list.

### Removed
- Stray `@ttthree/tokmon` self-dependency that pinned the package to a
  `pkg.pr.new` preview URL.

## [0.1.8] – 2026-04-18

### Fixed
- `tokmon --version` now reads from `package.json` instead of a stale
  hard-coded string.

## [0.1.7] – 2026-04-18

### Added
- Stacked cost bars per source in the **Token & Cost Trend** chart when
  the source filter is set to "all".
- Chart legend so users can identify each token series and cost source.

### Changed
- npm registry version-check timeout bumped from 3s to 8s (cold DNS/TLS
  was frequently triggering "operation was aborted" toasts).
- Dashboard re-checks for new releases every 5 minutes instead of only
  on initial mount.

## [0.1.6] – 2026-04-17

### Added
- Corpus-backed test harness with golden snapshots.
- E2E UI tests for the dashboard.

### Fixed
- Token accounting accuracy fixes (cache-hit rate, double-count, project
  attribution) for Copilot CLI sessions.

## [0.1.5] – 2026-04-15

### Fixed
- Codex parser gracefully handles older/alternate threads schemas.

## [0.1.4] – 2026-04-13

### Added
- Port auto-fallback when default port is busy.
- Mars orchestrator session source.
- Settings tab and friendly machine name.
- Chart label split-color polish.

### Fixed
- Windows-safe pricing filenames.
- Codex rollout JSONL parsing for turns/tools/duration/replay.
- `chmod +x dist/cli/index.js` so the npx-installed binary is executable.

## [0.1.0] – 2026-04-12

### Added
- Initial release with Claude Code, Codex, Copilot CLI, and Eureka source
  support, GitHub sync, and the dashboard.
