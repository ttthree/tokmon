# DESIGN — Phase 1: Corpus tooling + first corpus

**Parent design:** [DESIGN-test-harness.md](./DESIGN-test-harness.md)
**Phase:** 1 of 4
**Status:** Draft v2 (post-design-review)

## Goal

Build the foundation of the test harness: a CLI tool that samples and sanitizes a public corpus from the developer's real `$HOME`, plus a parser-roundtrip vitest suite that compares parsed output to a frozen golden file.

After Phase 1, CI runs `npm run test:unit && npm run test:corpus` green.

## Scope (in)

1. Hidden CLI subcommand group `tokmon corpus` with: `sample`, `sanitize`, `verify`, `regenerate-golden`.
2. Sampling tool that captures sessions from CC / Eureka / Codex / Copilot CLI / Mars into a self-contained `home/` directory tree.
3. Sanitization pipeline (mandatory; runs as part of `sample`; `sanitize` subcommand re-runs on existing corpus).
4. PII verification step (`corpus verify`).
5. First corpus committed at `tests/corpus/snapshots/2026-04-default/`, total ≤ 5 MB.
6. `tests/corpus/parser-roundtrip.test.ts` comparing live parse output to `golden/sessions.json`.
7. NPM scripts + GitHub Actions CI wiring.

## Scope (out)

Same as before — Phase 2/3/4 work.

## Architecture

### Existing APIs we will use (corrected)

There is **no** `collectAll()`. The existing entry points:

- `collectCommand(options)` in `src/cli/commands/collect.ts` — production path; runs all parsers, calls `enrichSession`, persists `MachineData` via `saveMachineData`. It has side effects (writes to `~/.tokmon/machines/`) and uses an incremental cursor.
- Each parser exposes `.parse(context)` returning `{ sessions, cursorUpdates }` (see `src/core/types.ts`).
- `parsers` array in `src/parsers/index.ts` enforces order: `[marsParser, eurekaParser, claudeCodeParser, codexParser, copilotCliParser]`.
- `enrichSession(session, machineId, config)` is currently a private function inside `collect.ts`. **Refactor:** extract `enrichSession` (and `enrichSessionsBatched` if useful) into a new module `src/core/enrich.ts` and re-export from `collect.ts` to preserve the existing import surface. This is a pure code move (no behavior change) and unblocks both `parseAllPure` and future test reuse.

We add **a new pure helper** for corpus + tests:

```ts
// src/cli/commands/corpus/parse-pure.ts
export interface ParseAllPureOptions {
  /** Force-enable all detected sources regardless of config (used by sampler & golden gen). */
  forceAllSources?: boolean;
}
export async function parseAllPure(options?: ParseAllPureOptions): Promise<Session[]>;
```

Behavior:
1. Load config via `loadConfig()`.
2. If `forceAllSources`, replace `config.sources` with `detectAvailableSources()` all-enabled.
3. Build a fresh, empty cursor (no `existingCursor`, no incremental skipping).
4. Run each parser in the existing order with that cursor.
5. For each parsed session, call the extracted `enrichSession()`.
6. Return the merged `Session[]`. **Does NOT** write to `~/.tokmon/machines/`.

For sampling AND golden regeneration we always pass `forceAllSources: true` to guarantee the corpus exercises every source category that exists on disk.

**On "pure" semantics:** `parseAllPure()` does NOT write `MachineData`. However, `loadConfig()` may write back a freshly auto-detected `config.json` as a side effect (existing behavior in `src/core/config.ts`). For Phase 1 this is acceptable because:
- The corpus's `TOKMON_HOME` is a self-contained tmp/test dir, so any `config.json` writes go there, not to the dev's real `~/.tokmon/`.
- For sampling against the dev's real HOME, this is the same write `tokmon collect` would do anyway.

We do not introduce a parallel read-only config path in Phase 1; if true zero-side-effect semantics become important later, we can add `loadConfigReadOnly()` in a follow-up.

### Environment variable contract (corrected)

All HOME-redirection in tokmon goes through `getHomeDirectory()` in `src/core/config.ts`, which honors `TOKMON_HOME`. There is no `HOME` override path.

For the corpus, we therefore:

| Var | Set to | Purpose |
|---|---|---|
| `TOKMON_HOME` | `<corpus>/home` | All parsers + `~/.tokmon/...` paths root here |

That's it. **`TOKMON_PRICING_DIR` and `TOKMON_NOW` are dropped from the design**:
- Pricing: place `pricing/latest.json` at `<corpus>/home/.tokmon/pricing/latest.json`. The existing `getPricingDirectory()` path (`<TOKMON_HOME>/.tokmon/pricing`) picks it up automatically.
- Determinism: handled in the loader by post-processing parser output (sort + epoch-relativize timestamps) rather than mocking `Date.now()`. Parsers don't call `Date.now()` for anything that goes into `Session` shape we test against — they read mtimes/timestamps from files. Files in the committed corpus have stable contents but file mtimes will differ on each clone, so we **also** copy file mtimes from `manifest.fileMtimes` in the loader (see "Mtime restoration" below).

### Sampling pipeline (corrected)

**Note on file discovery:** `Session` (see `src/core/types.ts`) has no `filePath` field. So sampling **does not** read the Session output to learn file paths. Instead, the sampler has a small per-source `discover(sourceEntry) → DiscoveredSession[]` helper that mirrors each parser's directory walk (read-only file/path discovery). It MAY perform **lightweight header parsing** where required to classify or link a session — specifically:

- For Eureka: read the first line of `session.jsonl` to extract `engine`, `sdkSessionId`, `sdkCwd` (needed to split `eureka-claude` vs `eureka-codex` and to find linked SDK files for copy).
- For Codex rollout: optionally read first line for thread metadata when needed.
- For all others: pure path walk; no content parsing.

`discover()` lives in `src/cli/commands/corpus/discover.ts` and shares constants/path-helpers with the parsers (e.g. `getAllClaudeDirectories()`, encoded project path). It yields `{ sessionId, sourceCategory, primaryFile, auxFiles[], headerInfo? }`.

```
1. Source enumeration: ignore user config enable/disable — sampling explicitly forces all
   source types ON by constructing a synthetic SourceEntry list from
   `detectAvailableSources()`, with `enabled: true` for every detected path.
   Then run `discover()` per source to enumerate candidate sessions + their files.
   (We do NOT use parseAllPure here — that's only for golden generation.)

2. Group sessions by source category for stratification:
   - claude-code (from ~/.claude/)
   - claude-code-craft (from ~/.craft-agent/.claude/, unclaimed)
   - eureka-claude (engine: "claude")
   - eureka-codex (engine: "codex")
   - codex
   - copilot-cli

3. Mars trees: query Mars sqlite (read-only) to enumerate distinct task_id values; each Mars
   "tree" = all sessions with the same task_id (claude/codex/copilot mix). We sample whole trees
   atomically: pick top N task_ids by hash(seed + taskId), pull every session with that task_id,
   include all underlying engine files for those sessions. The Mars sqlite itself is then
   filtered to retain only rows for chosen task_ids (see SQLite sanitize).

4. Stratified pick (per non-Mars source):
   - sort sessions by hash(seed + sessionId) (stable across runs with same --seed)
   - take first N (default 25)

5. Materialize into <out>/home/ preserving directory structure under TOKMON_HOME-relative paths:
   - For each chosen session, copy its primary file(s).
   - For Eureka with sdkSessionId: ALSO copy the underlying CC/Codex SDK session file
     and any sub-agents at {sdkSessionId}/subagents/*.jsonl.
   - For CC sessions: ALSO copy any sub-agent files at {sessionId}/subagents/.
   - For Codex: copy both rollout file AND its row in state_N.sqlite.
   - For Mars: copy agent-configs/{claude,codex,copilot}/ as needed by selected engine sessions.
   - All copies go through sanitizeFile() inline (jsonl) or sanitizeSqlite() (sqlite).

6. Truncation: files >256KB are line-safe head+tail truncated:
   - keep first ~192KB of complete lines
   - keep last ~64KB of complete lines (the tail must contain the parser's "marker" line —
     for Codex this is total_token_usage; for CC the head+tail mode preserves cumulative usage)
   - inject a single line `{"_truncated":true}` between head and tail (parser ignores unknown lines)
   - Codex rollout files: ensure the FINAL `total_token_usage` event is present — if not
     in last 64KB, expand the tail until it is (corpus correctness > size cap).

7. Compute sha256 of every materialized file; record in manifest.fileMtimes (path → mtime ms)
   and manifest.sha256 (overall hash of sorted file hashes).

8. Write manifest.json + pricing/latest.json (frozen snapshot from current ~/.tokmon/pricing/latest.json,
   sanitized to remove any URLs leaking host info).

9. Run verify() — fail loudly if any check trips.
```

### Sanitization rules (corrected to match parser needs)

Per-kind whitelists (everything outside the whitelist is dropped or blanked):

- **`cc` (Claude Code .jsonl line):** keep `type`, `timestamp`, `sessionId`, `parentUuid`, `uuid`, `isSidechain`, `cwd` (after sanitizePath), `gitBranch`, `userType`, `version`, `summary` → blank, `message.role`, `message.model`, `message.usage`, `message.id`, `message.stop_reason`. For `message.content[]`: keep `type`, `name` (tool name), `tool_use_id`, `id`, `input` keys but blank values, `is_error`. Blank `text`, `input` values, `content` text. Keep `toolUseResult.totalTokens` if present.
- **`eureka-header` (first line of Eureka session.jsonl):** keep `id`, `engine`, `sdkSessionId`, `sdkCwd` (sanitized), `tokenUsage`, `costUsd`, `messageCount`, `userMessageCount`, `workingDirectory` (sanitized), `model`, `createdAt`, `updatedAt`. Rewrite `name` → `session-<seq>`.
- **`eureka-body` (subsequent lines):** same as `cc`.
- **`codex` rollout `.jsonl`:** keep `type`, `timestamp`, the entire `payload` object when `payload.type === "token_count"` (this contains `total_token_usage` per AGENTS.md). For other payload types, keep `payload.type` + `payload.id` + `payload.tool_name`/`call_id` (drop free text). **Do not** strip `total_token_usage` ever.
- **`codex sqlite` (state_N.sqlite):** re-emit a new sqlite with only the `threads` table, columns `id`, `cwd` (sanitized), `title` → `thread-<seq>`, `created_at`, `updated_at`, `tokens_used`. Preserve only rows whose thread id is among selected.
- **`mars sqlite` (marsiwe.db):** re-emit with `sessions`, `tasks`, `workspaces` tables — only the columns/rows the Mars parser SELECT requires (see `loadMarsRows` in `src/parsers/mars.ts`). Workspace `name` → `workspace-<seq>`, `path` → `/Users/testuser/work/workspace-<seq>`. Task `title` → `task-<seq>`. Session `name` → `session-<seq>`.
- **Eureka telemetry `llm-telemetry.jsonl`:** keep `timestamp`, `provider`, `model`, `turnId`, `duration`, `requestId`. Null/blank text fields. (Per AGENTS.md, telemetry is only used for timestamps + provider, so per-line stripping is safe.)
- **`copilot` `process-*.log`:** these are structured JSON-line logs. Keep events of type `assistant_usage` and `cli.model_call` (with their numeric payloads). Drop other events entirely or replace with `{"event":"redacted"}` to preserve line count. **For every retained event**, the original `timestamp` field MUST be preserved verbatim and parseable as an ISO-8601 string — `verify` runs an explicit check that all retained Copilot events have a valid timestamp (else fail), because the Copilot parser falls back to `Date.now()` when timestamps are missing/invalid (see `src/parsers/copilot-cli.ts:288`), which would break golden determinism.

### `corpus verify` checks (unchanged)

1. Real username regex: `\b<os.userInfo().username>\b`
2. Email regex
3. Absolute path outside `/Users/testuser` or `/tmp` or `/var`
4. Any string field listed in scrub-blank-list with `length > 100`

Plus a new check:
5. **Parse-still-works** — runs `parseAllPure()` against the corpus's `TOKMON_HOME` and asserts session count > 0 for every represented source. Catches over-aggressive sanitization.

### `corpus regenerate-golden` (corrected)

```
1. Set TOKMON_HOME = <corpus>/home
2. Restore mtimes from manifest.fileMtimes (so cursor-based parsers see consistent times)
3. Call parseAllPure()
4. Sort sessions by (source, sessionId); convert every timestamp/mtime field to seconds offset
   from manifest.epoch (a fixed value chosen at corpus creation)
5. Write golden/sessions.json
```

### Mtime restoration (NEW)

When git checks out the corpus, file mtimes are checkout time, not original. Some parsers use mtime as session timestamp. To make goldens reproducible, the manifest stores the original mtime per relative path. The loader (and golden regenerator) call `fs.utimes()` to restore mtimes before parsing.

### `manifest.json` schema (extended)

```json
{
  "id": "2026-04-default",
  "schemaVersion": 1,
  "createdAt": "2026-04-18T...Z",
  "epoch": 1700000000000,
  "seed": 42,
  "sourceCounts": {
    "claude-code": 25,
    "claude-code-craft": 8,
    "eureka-claude": 12,
    "eureka-codex": 5,
    "codex": 10,
    "copilot-cli": 8,
    "mars-trees": 3
  },
  "fileMtimes": {
    "home/.claude/projects/.../abc.jsonl": 1700000000000
  },
  "totalBytes": 4823100,
  "tokmonVersion": "0.1.6"
}
```

### `corpora.json` registry (unchanged)

### Test loader (corrected)

```ts
export interface LoadedCorpus {
  id: string;
  manifest: Manifest;
  homeDir: string;          // <root>/home
  goldenDir: string;
}
export async function loadCorpus(id: string): Promise<LoadedCorpus>;
export async function listCorpora(): Promise<{ id: string; root: string }[]>;
export function withCorpusEnv<T>(corpus: LoadedCorpus, fn: () => Promise<T>): Promise<T>;
//   - sets process.env.TOKMON_HOME
//   - restores file mtimes from manifest before fn(), restores prev env after
```

### `parser-roundtrip.test.ts` (corrected)

```ts
const corpora = await listCorpora();
describe.each(corpora)("corpus $id", ({ id }) => {
  it("parses to golden sessions.json", async () => {
    const corpus = await loadCorpus(id);
    await withCorpusEnv(corpus, async () => {
      const sessions = await parseAllPure();
      const normalized = normalizeForGolden(sessions, corpus.manifest.epoch);
      const golden = JSON.parse(await fs.readFile(`${corpus.goldenDir}/sessions.json`, "utf8"));
      expect(normalized).toEqual(golden);
    });
  });
});
```

`normalizeForGolden`: sorts by `(source, sessionId)`; replaces every numeric/string timestamp with `epoch + Δseconds` integer (recursive walk); strips machine-id (placeholder `"machine"`).

### CI

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build
      - run: npm run test:unit
      - run: npm run test:corpus
```

### NPM scripts

```json
"corpus:sample":            "tsx src/cli/index.ts corpus sample --out tests/corpus/snapshots/2026-04-default",
"corpus:regenerate-golden": "tsx src/cli/index.ts corpus regenerate-golden --corpus tests/corpus/snapshots/2026-04-default",
"corpus:verify":            "tsx src/cli/index.ts corpus verify tests/corpus/snapshots/2026-04-default",
"test:corpus":              "vitest run tests/corpus"
```

(Default to the only known corpus id; users override via the CLI flag if needed.)

## Test Strategy

### Unit tests

`tests/unit/corpus/sanitize.test.ts`:
- `sanitizePath` replaces real username and `/Users/<real>` correctly
- `sanitizeJsonlLine('cc', ...)` keeps usage/model/uuid, blanks `text`
- `sanitizeJsonlLine('eureka-header', ...)` rewrites name and workingDirectory
- `sanitizeJsonlLine('telemetry', ...)` nulls prompt/response
- `sanitizeJsonlLine('codex', ...)` PRESERVES `total_token_usage` payload
- `sanitizeSqlite` produces reduced schema with scrubbed titles, retains tokens_used
- Verify catches: real username, email, foreign abs path, long content string

`tests/unit/corpus/sample.test.ts`:
- Stratified pick is deterministic with same seed (synthetic input list)
- Mars tree expansion: given fake registry rows, all sessions sharing a task_id are picked together
- File >256KB head+tail truncation produces a syntactically valid jsonl with `_truncated` marker
- Codex truncation guarantees `total_token_usage` line is in tail

`tests/unit/corpus/parse-pure.test.ts`:
- Against existing `tests/helpers/fixtures.ts`-built test home, `parseAllPure()` returns a Session[] without writing to `~/.tokmon/machines/`

### E2E test (REQUIRED)

`tests/corpus/parser-roundtrip.test.ts`:
- Loads `2026-04-default` corpus
- Runs `parseAllPure()` against corpus's TOKMON_HOME
- Asserts equality to `golden/sessions.json`
- Corpus must include at least one session for each represented source category (excluding mars itself, which only emits registry tagging — verified by checking the sourceCounts in manifest)

### Edge cases

- Empty source dir tolerated (test home with no `.codex/` dir → codex parser returns empty)
- Truncated file (head+tail mode) parses correctly
- Mars sample with task that has only one engine session works
- Sanitize on already-sanitized corpus is idempotent

## Acceptance criteria

1. `tokmon corpus sample --out tests/corpus/snapshots/2026-04-default` runs to completion against developer's real `$HOME`.
2. Resulting corpus directory is ≤ 5 MB.
3. `tokmon corpus verify <corpus>` passes (no PII leaks; parse still works).
4. `npm run test:corpus` passes.
5. `npm run test:unit` still green.
6. `npm run build && npm link` succeeds; `tokmon corpus --help` works.
7. CI workflow file exists and runs unit + corpus tests.

## Decisions captured from review

- **No `collectAll()`**; introduce `parseAllPure()` helper.
- **`enrichSession` extracted to `src/core/enrich.ts`** as a pure code move, re-exported from `collect.ts` to preserve existing imports. Required so `parseAllPure()` can call it.
- **Sampler uses force-all-sources**, NOT user config — guarantees corpus exercises every detected source category regardless of user enable/disable state.
- **Sampler does NOT learn file paths from `Session` output** (`Session` has no `filePath`). It uses a dedicated `discover()` helper that mirrors each parser's directory walk (read-only).
- **Env var is `TOKMON_HOME`** (not `HOME`); no `TOKMON_PRICING_DIR` (pricing lives under `<TOKMON_HOME>/.tokmon/pricing/`); no `TOKMON_NOW` (determinism handled by mtime restoration + epoch-relativizing timestamps in goldens).
- **Sanitization whitelist expanded** to keep `uuid`, `parentUuid`, `cwd`, `isSidechain`, `gitBranch`, `cost-relevant subfields`, `tool_use_id`, etc. — all fields parsers actually read.
- **Copilot timestamps preserved verbatim** on retained events; verify enforces this to keep goldens deterministic.
- **Mars "tree" = task_id grouping** (sqlite query). Not parent-child uuid links.
- **Sub-agents copied with parent**: CC parser discovers them as separate sessions; Eureka parser merges them via `sdkSessionId`. Sampler always copies both direct selected sessions AND any subagents directory beside their primary file.
- **Truncation is line-safe and source-aware** (Codex's `total_token_usage` always preserved).
- **Mtime restoration** via manifest is mandatory for golden reproducibility.
- **Acceptance wording fixed**: "at least one session per represented source category"; Mars excluded since it doesn't emit `Session` entries directly.
