# tokmon

[![npm version](https://img.shields.io/npm/v/@ttthree/tokmon.svg)](https://www.npmjs.com/package/@ttthree/tokmon)
[![npm downloads](https://img.shields.io/npm/dm/@ttthree/tokmon.svg)](https://www.npmjs.com/package/@ttthree/tokmon)
[![CI](https://github.com/ttthree/tokmon/actions/workflows/ci.yml/badge.svg)](https://github.com/ttthree/tokmon/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ttthree/tokmon.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@ttthree/tokmon.svg)](https://nodejs.org/)

Token usage monitor for AI coding agents — track costs, review sessions, optimize workflows.

Supports **Claude Code**, **Codex**, **Copilot CLI**, **Eureka**, and **Mars** orchestrator sessions. Aggregates across machines, breaks down by project / model / agent / machine, and exposes it all in a clean web dashboard.

---

## Quick start

Run without installing:

```bash
npx @ttthree/tokmon
```

Or install globally:

```bash
npm install -g @ttthree/tokmon
tokmon
```

That's it — tokmon scans your local agent directories (`~/.claude`, `~/.codex`, `~/.craft-agent`, …), writes its own data under `~/.tokmon/`, and opens the dashboard at `http://localhost:3000`.

**Requirements:** Node.js >= 20.

---

## Detailed usage

### Commands

```bash
tokmon              # collect + start dashboard (default)
tokmon config       # show current configuration
tokmon config set <key> <value>
tokmon config add-project <name> <folder>
tokmon config exclude-folder <pattern>
tokmon --help       # full CLI reference
```

`collect`, `serve`, and `sync` are also available as hidden subcommands for advanced workflows.

### Options

| Option | Description |
| --- | --- |
| `--port <port>` | Dashboard port (default `3000`). If omitted and the port is busy, tokmon auto-falls-back to the next free port (up to 10 tries). Pass `--port` explicitly to disable fallback. |
| `--no-open` | Don't auto-open the browser. |
| `--reset` | Reprocess all sessions from scratch (drops the cursor and re-parses everything). |
| `-V`, `--version` | Print the version. |
| `-h`, `--help` | Show help. |

### Data locations

- Config + machine data: `~/.tokmon/`
- Pricing snapshots: `~/.tokmon/pricing/` (auto-refreshed from LiteLLM)
- Scanned sources (read-only): `~/.claude`, `~/.codex`, `~/.craft-agent`, `~/.copilot` (where present)

### Multi-machine sync (optional)

tokmon can sync per-machine data through a private GitHub repo so one dashboard aggregates all your devices:

```bash
tokmon config set github.repo <owner>/<repo>    # private repo
tokmon sync --init                              # bootstrap
tokmon sync                                     # incremental
```

`github.repo` accepts `owner/repo`, HTTPS clone URLs, or SSH remotes such as `git@github.com:owner/repo.git` and `git@gh:owner/repo`.

Requires `git` plus working Git credentials, such as a credential helper for HTTPS or an SSH key/config.

The sync branch is treated as a latest-state snapshot, not an audit log: each successful `tokmon sync` rewrites the branch to a single current snapshot commit and uses `--force-with-lease` to avoid blind overwrites when another machine pushed first.

### Native module note

tokmon depends on [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3). npm downloads a prebuilt binary for most platform/Node combos. If no prebuilt matches, it compiles from source — you'll need:

- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `build-essential` + `python3`
- **Windows**: Visual Studio with the "Desktop development with C++" workload

If `npx @ttthree/tokmon` seems stuck on first run, it's most likely compiling native bindings — subsequent runs use the cached binary.

---

## License

MIT
