# Changelog

All notable changes to `@ttthree/tokmon` will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
