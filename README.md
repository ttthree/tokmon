# tokmon

Token usage monitor for AI coding agents — track costs, review sessions, optimize workflows.

Supports **Claude Code**, **Codex**, **Copilot CLI**, **Eureka**, and **Mars** orchestrator sessions. Aggregates across machines, breaks down by project / model / agent / machine, and exposes it all in a clean web dashboard.

## Quick start

```bash
npx @ttthree/tokmon
```

This collects local sessions from your agent tool directories (`~/.claude`, `~/.codex`, etc.), stores them in a local SQLite DB under `~/.tokmon/`, and opens the dashboard in your browser.

## Install globally

```bash
npm install -g @ttthree/tokmon
tokmon
```

## Requirements

- **Node.js >= 20**
- A C/C++ toolchain for `sqlite3` native bindings (see note below)

## Note on `sqlite3`

tokmon uses the [`sqlite3`](https://www.npmjs.com/package/sqlite3) native module for local storage. On first install, npm downloads a prebuilt binary if one is available for your platform/Node version. If no prebuilt matches, it falls back to compiling from source, which requires:

- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `build-essential` + `python3`
- **Windows**: Windows Build Tools — run `npm install --global --production windows-build-tools` once, or install Visual Studio with the "Desktop development with C++" workload

If `npx @ttthree/tokmon` seems stuck on install, it's most likely compiling sqlite3. Give it a minute; subsequent runs are cached.

## Commands

```bash
tokmon              # collect + start dashboard (default)
tokmon collect      # collect sessions only
tokmon serve        # start dashboard without re-collecting
tokmon --help       # full CLI reference
```

## License

MIT
