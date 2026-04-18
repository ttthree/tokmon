# DESIGN — Concurrent-Run Mutex for tokmon

## Background

`tokmon` mutates a single per-machine JSON store at `~/.tokmon/machines/{machineId}.json` (the "store"). The mutating flow is `loadMachineData → modify in memory → saveMachineData (write tmp + rename)`.

`saveMachineData` is **atomic at the filesystem level** (POSIX `rename`), but the `load → modify → save` sequence is **not atomic across processes**. When two `tokmon` processes run concurrently (e.g. a manual `tokmon --reset` while the dashboard's 5-minute background `collectCommand()` is also running), both read the same baseline, both mutate, and the last writer wins — silently dropping the other's work.

### Concrete observed damage (2026-04-18)

User and Architect both ran `tokmon --reset` overlapping. Result:
- Eureka session `260409-strong-panther` (sdkSessionId `d63fb4aa…`) was correctly attributed to `eureka` source by run A.
- The same `d63fb4aa…` was also attributed (incorrectly) to the `claude-code` source — likely because run B saved a snapshot built before run A's `claimedCcSessionIds` had been fully populated, or merged stale store contents back in.
- Net: ~$45 of double-counted spend on Apr 12 (CC `$55.76` instead of the correct `$10.76` after a clean re-run).

A single-instance mutex on the store eliminates this class of bug.

## Goals

1. Guarantee that at any moment, **at most one process is mutating** a given `~/.tokmon/machines/{machineId}.json`.
2. When a second `tokmon` invocation tries to run while another holds the lock, by default it **fails fast** with a clear error message; an opt-in `--wait` flag lets it block until the holder finishes.
3. Detect and clean up **stale locks** (holder died without releasing).
4. Zero new runtime dependencies.
5. Keep the lock scope **narrow and visible**: only the mutating critical section is inside the lock, not the entire CLI lifetime, and not read-only commands.

## Non-Goals

- Cross-machine locking. The store is per-machine; a per-machine lockfile is sufficient.
- Locking the GitHub sync repo or the pricing cache. These are already idempotent / use their own scratch directory.
- Replacing the existing tmp-file + rename atomic write inside `saveMachineData`. That is orthogonal and stays.
- Locking read-only paths (`tokmon serve`, dashboard HTTP reads, `aggregateData`). Reads are tolerant of seeing either pre- or post-mutation state.

## Design

### Lock file location and naming

- Path: `~/.tokmon/machines/{machineId}.json.lock`
- Lives next to the store. Easy to discover; `ls ~/.tokmon/machines/` shows it.
- Distinct per machine — multiple machines on shared NFS would not collide (not a real scenario, but cheap to support).

### Lock protocol — exclusive `O_CREAT | O_EXCL` lockfile

Use `fs.open(lockPath, "wx")` (Node maps `wx` to `O_CREAT | O_EXCL | O_WRONLY`). The kernel guarantees that exactly one process succeeds when many race on the same path.

The acquired lockfile contains a JSON payload:

```json
{
  "pid": 12345,
  "host": "bogon-7a8a26",
  "command": "tokmon --reset",
  "acquiredAt": "2026-04-18T05:07:24.123Z"
}
```

Used for stale-lock recovery and for the human-readable error message.

### Stale-lock recovery

On `EEXIST` (lockfile already present):

1. Read the lockfile JSON. If it is malformed (truncated / missing fields / unparseable), treat as **stale**.
2. If `host` differs from current host, treat as **alive** (we conservatively never break locks held on another host; should not happen in practice).
3. If `host` matches and the `pid` does not exist on this host (`process.kill(pid, 0)` throws `ESRCH`), treat as **stale**.
4. If the lockfile is older than `STALE_LOCK_TIMEOUT_MS` (default **30 minutes**) regardless of `pid` liveness, treat as **stale**. (Defensive against frozen/zombied processes; a real `collect` run is well under this even on huge stores.)
5. Stale path: delete the lockfile and retry acquisition **once**. If the second attempt also fails with `EEXIST`, surface the error — do not loop, as that means another process raced us into the cleanup.

### Acquisition modes

The wrapper accepts a `wait` option:

- `wait: false` (default for **all CLI entry points**): single attempt + stale-recovery retry. On final failure, throw a `LockBusyError` carrying the holder metadata.
- `wait: true` (used by **background refresh**): poll every 500 ms with jitter, up to a configurable `LOCK_WAIT_TIMEOUT_MS` (default **2 minutes**). If timeout expires, throw `LockBusyError`.

`wait: true` is appropriate for the in-process `setInterval` background refresh in `run.ts` because that loop is non-interactive and a transient overlap with a user-triggered `tokmon collect --reset` should resolve in seconds.

### Release

On normal completion: `fs.unlink(lockPath)` in a `finally` block.

On crash: nothing — but stale-lock recovery handles it on the next run.

We **do not** try to install a `process.on('exit')` handler for cleanup; Node's `exit` is synchronous-only and unreliable for filesystem ops. The stale-lock check is the safety net.

### Critical section

The lock wraps the **entire** `loadMachineData → mutate → saveMachineData` sequence in `collectCommand`. Anything outside that sequence (pricing refresh, aggregate, serve) stays outside the lock.

GitHub `sync()` in `src/sync/github.ts` also calls `loadMachineData(machineId)` at line 42 to push the local store. It does NOT mutate the store, so it could in principle skip the lock. **We still take the lock** there because we want a consistent snapshot to push (no chance of pushing a half-written store). The lock around `sync` is held only during the brief `loadMachineData` read; the `git clone/commit/push` runs outside the lock.

### Public API

New module `src/core/lock.ts`:

```ts
export interface LockInfo {
  pid: number;
  host: string;
  command: string;
  acquiredAt: string;
}

export class LockBusyError extends Error {
  constructor(public readonly lockPath: string, public readonly holder: LockInfo | null) {
    super(/* nice message */);
  }
}

export interface AcquireOptions {
  wait?: boolean;          // default false
  waitTimeoutMs?: number;  // default 120_000
}

/**
 * Acquire an exclusive lock on `lockPath`. Returns a release function.
 * The release function is idempotent.
 */
export async function acquireLock(lockPath: string, options?: AcquireOptions): Promise<() => Promise<void>>;

/**
 * Convenience: run `fn` while holding the machine-store lock.
 */
export async function withMachineStoreLock<T>(
  machineId: string,
  fn: () => Promise<T>,
  options?: AcquireOptions,
): Promise<T>;
```

### Integration points

| File | Change |
|------|--------|
| `src/core/lock.ts` | NEW — implements `acquireLock`, `withMachineStoreLock`, `LockBusyError`. |
| `src/core/config.ts` | Add `getMachineLockPath(machineId)` helper (next to `getMachineDataPath`). |
| `src/cli/commands/collect.ts` | Wrap the body of `collectCommand` from the `loadMachineData` call through the `saveMachineData` call in `withMachineStoreLock(machineId, …, { wait: options.wait })`. Add a new `wait?: boolean` field to `CollectOptions` (default false). |
| `src/cli/commands/run.ts` | Pass `wait: false` for the foreground `collectCommand` call (line 39). Pass `wait: true` for the background `setInterval` call (line 81). |
| `src/cli/index.ts` | Catch `LockBusyError` at the top-level `.action(...)` handlers for `tokmon` (default), `tokmon collect`, and `tokmon sync`; print a friendly message including the holder's pid/command/age and `process.exit(1)`. |
| `src/sync/github.ts` | Wrap the `loadMachineData` + write-to-repo block in `withMachineStoreLock` so we never push a partial snapshot. |

### Error message UX

When a user runs `tokmon --reset` while another instance is already running, they see:

```
✗ tokmon is already running on this machine
  pid:        70191
  command:    tokmon --reset
  started:    2026-04-18T05:07:24Z (3 minutes ago)
  lockfile:   /Users/jietong/.tokmon/machines/bogon-7a8a26.json.lock

Wait for it to finish, or remove the lockfile if you're sure it's stale.
```

If the lockfile JSON is malformed:

```
✗ tokmon is already running on this machine (lock metadata unreadable)
  lockfile:   /Users/jietong/.tokmon/machines/bogon-7a8a26.json.lock
```

### Backward compatibility

- No schema change to the store.
- No new dependencies.
- Read-only commands (`tokmon serve`, dashboard reads) are unchanged.
- A single foreground `tokmon` run on a clean machine sees zero new behavior.

### Performance

- One extra `open(O_EXCL)` + one extra `unlink` per `collect` run (~microseconds).
- Background `wait: true` poll: ≤4 polls/sec while waiting; bounded.

## Test Strategy

### Unit tests (`tests/unit/core/lock.test.ts`)

1. **happy path** — `acquireLock` succeeds when no lockfile exists; release deletes the file.
2. **busy path (wait: false)** — second `acquireLock` against same path throws `LockBusyError`; original lock still held; holder metadata in the error matches what was written.
3. **busy path (wait: true) — successful wait** — second `acquireLock({wait:true, waitTimeoutMs:5000})` blocks; release the first after 200 ms; second resolves; assert wait duration is in `[150, 1000]` ms.
4. **busy path (wait: true) — timeout** — second `acquireLock({wait:true, waitTimeoutMs:300})` throws `LockBusyError` after the timeout; first lock still held.
5. **stale by dead pid** — pre-write a lockfile with `host=os.hostname()` and a pid we know is dead (e.g. `999999` after asserting it's not in use); `acquireLock` succeeds and replaces the lockfile.
6. **stale by age** — pre-write a lockfile, then artificially `utimes` it to be older than 30 min; `acquireLock` succeeds.
7. **stale on different host — refuses to break** — pre-write a lockfile with `host="some-other-host"` and a fictional pid; `acquireLock` throws `LockBusyError` (does not delete the foreign lock).
8. **malformed lockfile content** — pre-write an invalid JSON lockfile; `acquireLock` succeeds (treated as stale), and the error message path of `LockBusyError` (when forced) reports "metadata unreadable".
9. **release is idempotent** — calling release twice does not throw.
10. **`withMachineStoreLock` wraps fn** — successful fn → lockfile gone; throwing fn → lockfile gone; rejected promise → lockfile gone (uses `finally`).
11. **race resilience** — spawn 5 concurrent `acquireLock({wait:true})` calls on the same path with a tiny critical section (`await sleep(20)`); assert all 5 complete and the lockfile is gone at the end (i.e., no permanent leak under high contention).

### End-to-end tests (`tests/e2e/concurrent-collect.test.ts`)

12. **two concurrent `collectCommand({reset:true})` — fail-fast** — start two collects in parallel against an isolated `TOKMON_HOME`. Exactly one resolves successfully; the other rejects with `LockBusyError`. The store on disk is in a consistent state: contains exactly the sessions one collect run would produce (verified by running a third collect and diffing).
13. **two concurrent `collectCommand` — wait mode** — start the second with `{wait: true}`; both eventually resolve; final store matches what a single sequential run produces (key set + token totals identical).
14. **CLI `tokmon collect` exits non-zero on busy** — spawn two child processes via `node dist/src/cli/index.js collect`; the second exits with code 1 and stderr contains "tokmon is already running".

All E2E tests use a temporary `TOKMON_HOME` (`process.env.TOKMON_HOME`) so they don't touch the developer's real `~/.tokmon`.

### Edge cases tested

- Lockfile path's parent directory doesn't exist yet (first-ever `tokmon` run).
- `EACCES` reading the lockfile: bubble up as a clear "cannot read lockfile" error rather than silently treating as stale.
- `release()` called when the lockfile was already deleted by stale-recovery on another process: no-op, no throw.
- `process.kill(pid, 0)` raising `EPERM` (pid exists but owned by another user): treat as **alive**, do NOT break the lock.

### Acceptance criteria

- `npm run test:unit` passes (existing + 11 new lock unit tests + 3 new E2E tests).
- `npx tsc -b --pretty false` clean.
- `npm run build && npm link` produces a CLI where `tokmon --reset` run twice in parallel reliably has one succeed and one print the friendly busy error.
- Re-running `node /tmp/inspect-apr12.mjs` after the fix on a populated store produces the same numbers as a clean sequential `--reset` (i.e., no double-count regression).
