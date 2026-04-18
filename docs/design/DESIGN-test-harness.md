# DESIGN — tokmon Test Harness

**Status:** Draft
**Owner:** jietong
**Date:** 2026-04-18

## Goals

Build a layered test harness that gives high confidence in:

1. **Parser correctness** — every agent's session-file format (Claude Code, Eureka, Codex, Copilot CLI, Mars) parses to the expected `Session` shape, including edge cases (large files, malformed lines, missing fields, multi-model sessions).
2. **Attribution correctness** — Eureka ↔ CC linking via `sdkSessionId`, Mars ↔ underlying engine linking, no double-counting between sources, correct `claimedCcSessionIds` propagation.
3. **Aggregation correctness** — cost calculations (`tokens × pricing`), per-model breakdown, per-project rollups, per-day series, leaderboards.
4. **UI correctness** — dashboard rendering, filters (project / agent / date range / model), drill-down behavior, search.

The harness must run **deterministically in CI** (no machine-specific paths, no network, no clock drift) **and** locally against the developer's real `~/.claude`, `~/.codex`, `~/.craft-agent` data for regression checks.

## Non-goals

- Performance/load testing (separate concern).
- Pricing data correctness (LiteLLM is upstream truth; we only test our lookup logic).
- Visual regression testing of dashboard (Playwright snapshots are out of scope for v1).

---

## Architecture

Three test tiers, each with its own fixture strategy:

```
┌─────────────────────────────────────────────────────────────────┐
│  Tier 1 — Synthetic Unit Fixtures (existing, expand)            │
│  tests/unit/parsers/*.test.ts                                   │
│  Hand-crafted minimal jsonl/sqlite via tests/helpers/fixtures.ts │
│  → Covers: parser edge cases, schema invariants, error paths    │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Tier 2 — Sampled Real-Data Corpus (NEW)                        │
│  tests/corpus/snapshots/<corpus-id>/                            │
│  Sanitized snapshots of real CC/Codex/Eureka/Mars sessions      │
│  → Covers: parser robustness on real shapes, attribution,       │
│            aggregation totals (golden numbers)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Tier 3 — UI E2E (existing playwright + corpus-backed server)   │
│  tests/e2e/*.spec.ts                                            │
│  Boots tokmon server pointed at corpus snapshot, drives UI      │
│  → Covers: rendering, filters, drill-downs                      │
└─────────────────────────────────────────────────────────────────┘
```

The key new artifact is **Tier 2** — a sampled, sanitized corpus that lives in-tree (small) or downloaded from a release artifact (large), and powers both backend golden tests and frontend E2E.

---

## Tier 1 — Synthetic unit fixtures (expand existing)

Already exists in `tests/helpers/fixtures.ts` and `tests/unit/parsers/*`. Gaps to fill:

| Parser | Add cases for |
|---|---|
| claude-code | files >5MB triggering head/tail mode; nested `cache_creation: {…}` objects in `usage`; multi-model session (haiku + opus); sub-agent files under `{sessionId}/subagents/`; malformed line in middle of file |
| eureka | engine=`codex` path; session with no `sdkSessionId` (old format → 0 tokens); session whose `sdkSessionId` is **missing** from CC dir (orphan); telemetry-only session |
| codex | `total_token_usage` event placement (last-8KB read); rollout file vs sqlite mismatch on cwd; multi-day rollout |
| copilot-cli | rotated logs; partial last line; missing `assistant_usage` events |
| mars | … (mirror per-engine paths) |

Each new test uses the existing `createTestHome()` + builder helpers — no real data, fully isolated `tmp/` HOME. **Already runs in CI today.**

---

## Tier 2 — Sampled real-data corpus (NEW, the bulk of this design)

### Corpus shape

```
tests/corpus/
├── README.md
├── snapshots/
│   ├── 2026-04-default/                # corpus id, dated
│   │   ├── manifest.json               # see schema below
│   │   ├── home/
│   │   │   ├── .claude/projects/…/<sid>.jsonl
│   │   │   ├── .craft-agent/.claude/projects/…/<sid>.jsonl
│   │   │   ├── .craft-agent/workspaces/<wid>/sessions/<sid>/session.jsonl
│   │   │   ├── .codex/state_0.sqlite
│   │   │   ├── .codex/sessions/2026/04/…/rollout-…jsonl
│   │   │   └── .copilot/logs/process-*.log
│   │   ├── pricing/                    # frozen pricing snapshot
│   │   │   └── latest.json
│   │   └── golden/
│   │       ├── sessions.json           # expected parsed Session[] (sorted, normalized)
│   │       ├── aggregates.json         # totals, per-model, per-project, per-day
│   │       ├── attribution.json        # claimedCcSessionIds, eureka→cc map
│   │       └── leaderboards.json
│   └── 2026-04-edge/                   # second corpus: edge cases discovered in wild
│       └── …
└── corpora.json                        # registry: id → location (in-tree | LFS | URL)
```

### Sampling tool: `tokmon corpus sample`

A new internal CLI subcommand (not shipped in `bin`, dev-only via `npm run corpus:sample`):

```
tokmon corpus sample \
  --out tests/corpus/snapshots/<id>/ \
  --max-sessions-per-source 25 \
  --max-bytes-per-file 256KB \
  --strategy stratified   # 'stratified' | 'random' | 'all'
  --seed 42
```

**Selection strategy (`stratified` default):**

For each source (`claude-code`, `eureka-claude`, `eureka-codex`, `codex`, `copilot-cli`, `mars-*`):
- Pick N sessions covering: smallest, largest, multi-model, multi-day, with sub-agents, with errors/empty usage. Hash-stable selection by `(source, sessionId)`.

**Sanitization (mandatory before commit):**

Walk every captured file and apply transformations:

1. **Path rewriting** — replace any absolute path containing the developer's username with `/Users/testuser`. Update CC encoded directory names accordingly.
2. **Content scrubbing** — for each line in `.jsonl`:
   - Drop `message.content[].text` and `message.content[].input` (keep structure but blank text). Tool names and types are preserved (we need them for parser tests).
   - Keep `message.usage`, `message.model`, `type`, `timestamp`, `sessionId`, `parentUuid`, `uuid` (required by parsers).
3. **SQLite scrubbing** — re-emit `state_N.sqlite` with only the columns parsers read (`thread_id`, `cwd`, `title`, timestamps, `tokens_used`); titles replaced with `"thread-<n>"`.
4. **Telemetry** — keep timestamps + provider + model; null out prompt/response text.
5. **Eureka session.jsonl headers** — keep `id`, `engine`, `sdkSessionId`, `sdkCwd`, `tokenUsage` (so we can verify we *don't* use it), `name` → `"session-<n>"`, `workingDirectory` rewritten.

Sanitization is enforced by a post-step `tokmon corpus verify` that fails if any file contains:
- the real username (compared against `os.userInfo().username`)
- absolute paths outside `/Users/testuser`
- email addresses (`/[\w.+-]+@[\w-]+\.[\w.-]+/`)
- strings >100 chars in content fields

Plus a manual review step before the first commit.

**Golden generation:**

After sampling+sanitizing, run the pipeline against the corpus to produce `golden/*.json`:

```
tokmon corpus regenerate-golden --corpus tests/corpus/snapshots/<id>/
```

This sets `HOME=<corpus>/home`, runs `collectAll()` with the frozen pricing snapshot, and writes:
- `sessions.json` — full `Session[]` sorted by `(source, sessionId)`, with `lastModified` normalized to a relative offset from corpus epoch.
- `aggregates.json` — output of `aggregate.ts` for all dimensions (per-source, per-model, per-project, per-day).
- `attribution.json` — `claimedCcSessionIds` set + `eureka.sdkSessionId → ccPath` resolved map.
- `leaderboards.json` — top-10 projects, top-10 models.

**Determinism:** all timestamps in goldens are stored as `epoch + Δseconds` integers; the test runner injects a fixed `Date.now()` via `vi.useFakeTimers()` plus a `TOKMON_NOW` env var for any code path that bypasses `Date`.

### Corpus storage

| Size | Strategy |
|---|---|
| < 5 MB total | Commit directly under `tests/corpus/snapshots/` |
| 5 – 50 MB | Git LFS, pointer in `corpora.json` |
| > 50 MB | GitHub Release artifact `corpus-<id>.tar.zst`; `npm run corpus:fetch` downloads + caches under `~/.cache/tokmon-corpus/` |

`corpora.json` declares which corpora the test suite expects, with a `sha256` checksum for integrity.

### Corpus tests

Three new test files under `tests/corpus/`:

```
tests/corpus/
├── parser-roundtrip.test.ts      # for each corpus: parse → compare to golden sessions.json
├── attribution.test.ts           # for each corpus: verify claim set + sdkSessionId map
└── aggregation.test.ts           # for each corpus: aggregate → compare to golden aggregates.json
```

Each test iterates corpora declared in `corpora.json`. Local devs can run a single corpus with `CORPUS=2026-04-default vitest run tests/corpus`.

**Diffing strategy:** golden files are JSON; comparison uses `expect(actual).toEqual(expected)`. On mismatch, vitest prints a diff. To update a golden after an intentional change, run `npm run corpus:regenerate-golden -- --corpus <id>` and review the diff in the PR.

---

## Tier 3 — UI E2E (extend existing)

Today `dashboard.spec.ts` boots the server against the dev's real HOME. Replace with corpus-backed boot:

```ts
// tests/e2e/helpers/serve-corpus.ts
export async function serveCorpus(corpusId: string): Promise<{ url: string; close: () => Promise<void> }>
```

This:
1. Sets `HOME=tests/corpus/snapshots/<id>/home`.
2. Sets `TOKMON_PRICING_DIR=tests/corpus/snapshots/<id>/pricing`.
3. Spawns `tokmon serve --port 0` as a child process; reads chosen port from stdout.
4. Returns URL + cleanup.

New E2E specs (Playwright):

| Spec | Verifies |
|---|---|
| `dashboard.spec.ts` | totals card numbers match `golden/aggregates.json.total` |
| `filters.spec.ts` | filtering by source / project / date / model updates totals to the matching subset of `golden/aggregates.json` |
| `leaderboards.spec.ts` | top-10 project & model lists match `golden/leaderboards.json` |
| `session-detail.spec.ts` | clicking a row opens the modal with correct per-model breakdown for a chosen `sessionId` from the corpus |
| `search.spec.ts` | leaderboard search reduces visible rows correctly |

All assertions reference the goldens, not hardcoded numbers — so corpus refresh propagates through.

---

## Local vs CI execution

| | Local | CI |
|---|---|---|
| `npm run test:unit` (Tier 1) | ✓ | ✓ |
| `npm run test:corpus` (Tier 2) | ✓ (auto-fetches LFS / release corpora not in tree) | ✓ |
| `npm run test:e2e` (Tier 3) | ✓ (Playwright) | ✓ (Playwright in headless) |
| `npm run test:real` (developer-only) | ✓ — runs parser smoke against real `$HOME`, asserts no crashes & non-empty result; **no equality checks** | ✗ |
| `npm run corpus:sample` | ✓ — refresh corpus from current `$HOME` | ✗ |

Add `npm run test:all` = unit + corpus + e2e. Wire into a single GitHub Actions job:

```yaml
- run: npm ci
- run: npm run corpus:fetch     # pulls release artifacts if needed
- run: npm run build
- run: npm link
- run: npm run test:all
```

E2E gets `playwright install --with-deps chromium` first.

---

## File layout summary (new files)

```
tests/
  corpus/
    README.md                          # how to add/refresh corpora
    corpora.json
    snapshots/2026-04-default/…        # the corpus
    helpers/
      load-corpus.ts                   # parses manifest, sets up HOME env
      serve-corpus.ts                  # for E2E
    parser-roundtrip.test.ts
    attribution.test.ts
    aggregation.test.ts
  e2e/
    filters.spec.ts                    # NEW
    leaderboards.spec.ts               # NEW
    search.spec.ts                     # NEW
src/
  cli/commands/corpus/
    sample.ts                          # `tokmon corpus sample`
    sanitize.ts                        # the scrubbing pipeline
    verify.ts                          # leak detector
    regenerate-golden.ts
    fetch.ts                           # download release artifacts
scripts/
  ci-test-all.sh
```

CLI registration: hidden subcommand group `corpus` (not exposed in `--help` for end users; documented in `tests/corpus/README.md`).

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Sanitization leaks PII | Automated `verify` step + manual review on first commit + `.gitattributes` requiring review on `tests/corpus/**` |
| Goldens become noisy/large | Normalize timestamps, sort deterministically, store as compact JSON; diff scoped per file |
| Real-format drift breaks goldens silently | Tier 1 synthetic tests catch shape changes; corpus refresh cadence is intentional (PR with diff = a documented format change) |
| LFS / release artifact unavailable in CI | `corpus:fetch` cached in CI; fallback small in-tree corpus always present so unit + corpus(small) pass without network |
| Dev's real HOME breaks `test:real` due to permission errors | `test:real` is opt-in (`TOKMON_REAL=1 npm run test:real`), failures don't block PRs |

---

## Phasing

**Phase 1 — foundation (1 sprint)**
- Implement `corpus sample` + `sanitize` + `verify`.
- Capture first corpus `2026-04-default` from developer machine; commit small (~3 MB).
- Implement `regenerate-golden` + `parser-roundtrip.test.ts`.
- CI runs Tier 1 + corpus parser tests.

**Phase 2 — attribution + aggregation (1 sprint)**
- `attribution.test.ts` + `aggregation.test.ts`.
- Add second corpus `2026-04-edge` for known-tricky sessions (orphan eureka, multi-model, large file).

**Phase 3 — UI (1 sprint)**
- `serve-corpus.ts` + new E2E specs driven by goldens.
- Migrate existing `dashboard.spec.ts` off real HOME.

**Phase 4 — maintenance**
- Document corpus refresh process; quarterly refresh cadence; PR-template checkbox for "refreshed corpus if format changed".

---

## Resolved decisions

1. **Single public sanitized corpus.** No private/dev-only corpus tier. Everything in-tree (or Release artifact for size) is sanitized and shareable.
2. **Mars sampling = whole orchestration tree.** When a Mars session is selected, its entire subtree (all spawned engine sessions + their files + state rows) is captured atomically. The sampler enumerates Mars sessions first, expands to their full transitive children, then samples *other* sources from what remains.
3. **`regenerate-golden` is manual.** Triggered by `npm run corpus:regenerate-golden`. PR template gets a checkbox for "regenerated and reviewed golden diff if parser/aggregation semantics changed".
