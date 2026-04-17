# tokmon CLI Simplification — Design Doc

## Goal

Replace the multi-command CLI (`collect`, `stats`, `serve`, `sync`, `config`) with a single `tokmon` command that does everything automatically:

```
$ tokmon
```

That's it. One command. It collects, syncs, and opens the dashboard.

## Current State

```
tokmon collect [--reset]     # parse sessions from all sources
tokmon sync [--init]         # push/pull via GitHub
tokmon serve [--port N]      # start dashboard server
tokmon stats [--by X]        # CLI table output
tokmon config [set|add-project|exclude-folder]
```

Users must run 3 commands to get from zero to dashboard: `collect` → `sync` → `serve`.

## Proposed Behavior

### Default command: `tokmon`

```
$ tokmon [--port N] [--no-open] [--reset]
```

1. **Collect** — run incremental session collection
2. **Sync** — if GitHub sync is configured AND initialized, push/pull; skip silently otherwise
3. **Serve** — start dashboard on port 3000 (or `--port N`), auto-open browser
4. **Watch** — while serving, re-collect + re-sync every 5 minutes in the background

Flags:
- `--port N` — dashboard port (default 3000)
- `--no-open` — don't auto-open browser
- `--reset` — reprocess all sessions from scratch before serving

Output:
```
$ tokmon
✓ Collected 3505 sessions (2.1s)
✓ Synced with GitHub (pulled 2, pushed)
● Dashboard → http://localhost:3000
```

Then stays alive serving the dashboard. Ctrl+C to quit.

### Subcommands kept (but hidden from default `--help`)

Keep these as escape hatches but don't advertise them:

- `tokmon config` — still needed for setup (`config set github.repo`, `config add-project`, etc.)
- `tokmon sync --init` — still needed for first-time GitHub setup
- `tokmon collect --reset` — available but also accessible via `tokmon --reset`

Remove `tokmon stats` — the dashboard fully replaces it.

## Implementation

### 1. Refactor `collectCommand()` to return structured results

**File: `src/cli/commands/collect.ts`**

Change `collectCommand()` signature from `Promise<void>` to return a result object:

```typescript
export interface CollectResult {
  sessionCount: number;
  durationMs: number;
}

export async function collectCommand(options: CollectOptions = {}): Promise<CollectResult> {
  const t0 = Date.now();
  // ... existing logic unchanged ...
  // Remove the console.log at the end
  return { sessionCount: sessions.length, durationMs: Date.now() - t0 };
}
```

The function no longer prints to stdout. Callers decide what/how to log.

### 2. Refactor `sync()` to NOT call `collectCommand()` internally

**File: `src/sync/github.ts`**

Remove the `await collectCommand()` call from inside `sync()`. The unified `run()` calls collect first, then sync. This eliminates double-collect.

Callers that previously relied on `sync()` doing collection (e.g., the hidden `tokmon sync` subcommand) should call collect explicitly before sync.

### 3. Define "sync not configured" state

**File: `src/core/config.ts`**

Change the default config to use empty string for `github.repo`:

```typescript
export const DEFAULT_CONFIG: AppConfig = {
  github: {
    repo: "",      // was "ttthree/tokmon-data" — empty means sync not configured
    branch: "main",
  },
  // ...
};
```

**New helper: `isSyncConfigured(config)`**

```typescript
export function isSyncConfigured(config: AppConfig): boolean {
  return config.github.repo.length > 0;
}
```

The `run()` function checks `isSyncConfigured()` before attempting sync. The hidden `tokmon sync` subcommand also uses this and prints a helpful message if not configured.

### 4. Handle server startup errors

**File: `src/server/index.ts`**

Modify `serve()` to handle `EADDRINUSE` and other startup errors:

```typescript
export async function serve(port = 3000): Promise<void> {
  const app = express();
  // ... existing middleware setup ...

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      resolve();
    });
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Use --port to pick another.`));
      } else {
        reject(error);
      }
    });
  });
}
```

In `run()`, if `serve()` throws, print the error and exit with code 1. This is a fatal error — no dashboard means nothing to show.

### 5. New: `src/cli/commands/run.ts`

Unified entry point:

```typescript
export async function run(options: { port: number; open: boolean; reset: boolean }) {
  // 1. Collect
  const collectResult = await collectCommand({ reset: options.reset });
  const elapsed = (collectResult.durationMs / 1000).toFixed(1);
  console.log(`✓ Collected ${collectResult.sessionCount} sessions (${elapsed}s)`);

  // 2. Sync (best-effort, non-fatal)
  const config = await loadConfig();
  if (isSyncConfigured(config)) {
    try {
      const result = await sync();
      console.log(`✓ Synced with GitHub (pulled ${result.pulled}, pushed=${result.pushed})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`⚠ GitHub sync failed: ${msg}`);
    }
  }

  // 3. Serve (fatal on failure)
  await serve(options.port);
  console.log(`● Dashboard → http://localhost:${options.port}`);

  // 4. Auto-open browser (non-fatal)
  if (options.open) {
    openBrowser(`http://localhost:${options.port}`);
  }

  // 5. Background refresh every 5 minutes (collect + sync)
  startBackgroundRefresh(config);
}
```

### 6. Background refresh policy

```typescript
let refreshRunning = false;

function startBackgroundRefresh(config: AppConfig): void {
  setInterval(async () => {
    if (refreshRunning) return;    // skip if previous run still in progress
    refreshRunning = true;
    try {
      await collectCommand();
      if (isSyncConfigured(config)) {
        await sync();
      }
    } catch {
      // silent — background refresh failures are not user-facing
    } finally {
      refreshRunning = false;
    }
  }, 5 * 60 * 1000);
}
```

Key decisions:
- **Overlapping runs are prevented** via the `refreshRunning` guard.
- **Both collect AND sync run** in the background loop, so remote data stays fresh.
- **Failures are silent** — the dashboard still shows stale data, which is better than crashing.

### 7. Browser auto-open

```typescript
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  exec(`${cmd} ${url}`, () => {
    // ignore errors — browser open is non-fatal
  });
}
```

Failure is non-fatal and silent (no error message). If `xdg-open` is missing or the user is SSH'd in, the URL is already printed to stdout.

### 8. Changes to `src/cli/index.ts`

```typescript
program
  .name("tokmon")
  .description("Token usage monitor for AI coding agents")
  .version("0.1.0")
  .option("--port <port>", "Dashboard port", Number, 3000)
  .option("--no-open", "Don't auto-open browser")
  .option("--reset", "Reprocess all sessions from scratch")
  .action(async (options) => {
    await run(options);
  });

// Keep config subcommand (visible — it's needed for setup)
const config = program.command("config")...  // unchanged

// Hidden escape hatches
program.command("collect", { hidden: true })...
program.command("sync", { hidden: true })...
program.command("serve", { hidden: true })...
```

### 9. Error behavior summary

| Step | On failure... |
|------|--------------|
| Collect | **Fatal on initial run.** Print error and exit 1. Background refresh: silent, serve stale data. |
| Sync | **Non-fatal.** Print warning, continue to serve. |
| Serve | **Fatal.** Print error (e.g., port in use) and exit 1. |
| Browser open | **Non-fatal.** Silent failure. URL already printed. |
| Background refresh | **Non-fatal.** Silent. Overlap guard prevents pile-up. |

### 10. Remove `stats` command

Delete `src/cli/commands/stats.ts`. Check if `src/cli/utils/format.ts` is used elsewhere — if only by stats, delete it too.

## Files to Change

| File | Action |
|------|--------|
| `src/cli/index.ts` | Rewrite — default action runs unified flow |
| `src/cli/commands/run.ts` | **New** — unified collect → sync → serve → watch |
| `src/cli/commands/collect.ts` | Refactor — return `CollectResult`, remove console.log |
| `src/cli/commands/stats.ts` | **Delete** |
| `src/cli/utils/format.ts` | Delete if orphaned after stats removal |
| `src/sync/github.ts` | Remove internal `collectCommand()` call, use `isSyncConfigured()` |
| `src/core/config.ts` | Change default repo to `""`, add `isSyncConfigured()` |
| `src/server/index.ts` | Add `EADDRINUSE` error handling |

## Test Strategy

### Unit tests

- `run()` — mock collect/sync/serve, verify:
  - Default flow calls collect → sync → serve in order
  - `--reset` passes through to collect
  - `--no-open` skips browser open
  - Sync skipped when `isSyncConfigured()` returns false
  - Sync failure is non-fatal (serve still starts)
  - Collect failure is fatal (throws/exits)
- `collectCommand()` — verify returns `CollectResult` with correct shape
- `isSyncConfigured()` — true when repo is non-empty, false when empty
- `startBackgroundRefresh()` — verify overlap guard works

### E2E tests

- `tokmon` with no args — starts server, verify HTTP 200 on `/api/data`
- `tokmon --port 0` — server picks a random port (if supported) or use a high port
- Port-in-use scenario — bind port first, run tokmon, verify error message

## Non-Goals

- No changes to parsers, dashboard UI, or data layer
- No changes to config schema (beyond default repo value)
- `config` subcommand stays as-is (it's the setup mechanism)
