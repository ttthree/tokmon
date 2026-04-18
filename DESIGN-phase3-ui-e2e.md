# Phase 3 — Corpus-backed UI E2E Tests (Revised)

## Goal

Migrate `tests/e2e/dashboard.spec.ts` from synthetic in-memory fixtures to **corpus-backed** Playwright tests that boot the real `tokmon` CLI against `tests/corpus/snapshots/<id>/home` and assert UI numbers match the Phase 2 goldens (`golden/aggregates.json`, `golden/sessions.json`, `golden/attribution.json`).

The new specs run against **both** corpora (`2026-04-default` and `2026-04-edge`). Playwright is already configured with `fullyParallel: false`, which serializes describes and prevents `TOKMON_HOME` collisions.

## Non-goals

- Visual regression / screenshot tests.
- Removing or rewriting the parser-roundtrip / corpus / unit suites.
- Any production code changes outside test wiring. Specifically: **no changes to `src/cli/index.ts`, `src/cli/commands/run.ts`, `src/server/index.ts`, or any `src/web/**`**. We adapt the tests to the existing CLI + UI surface.

## Resolved blocking issues from Round-2 review

| # | Issue | Resolution |
|---|---|---|
| R2-B1 | UI is **tabbed**: `project-leaderboard`/`project-row` only render in **Projects** tab; `search-input`/`session-table`/`session-row` only render in **Sessions** tab. Initial tab is `overview`. | Every spec begins with an explicit tab click via `await page.getByRole("button", { name: <tabLabel>, exact: true }).click()`. Tab labels (verified `App.tsx:644-650`): `Overview`, `Projects`, `Sessions`, `Settings`. Helper `gotoTab(page, server.url, tabName)` centralizes this. |
| R2-B2 | `ProjectActivityTable` default `pageSize` is **15**, not 10. | All assertions use `Math.min(15, projects.length)` and `goldens.aggregates.projects.slice(0, 15)`. |
| R2-B3 | `total-cost` testid is on the **inner value div** of `StatCard` (which itself has testid `stat-card`). The value div has `total-cost` and contains the `$X.XX` text directly (verified `StatCard.tsx:99,109,116`). | Spec uses `page.getByTestId("total-cost").textContent()` directly — no nested locator chain. |
| R2-B4 | `loadGoldens` previously stored `manifest` as the full `LoadedCorpus` object, so `goldens.manifest.epoch` would actually be `goldens.manifest.manifest.epoch`. | Helper now extracts the inner `Manifest` (with `epoch`) and stores it under `goldens.manifest`. Type is the `Manifest` interface from `tests/corpus/helpers/load-corpus.ts:4-8`. |
| R2-B5 | Date filter uses runtime `Date.now()` (`src/core/aggregate.ts:179`), but spec computed expected slice from corpus `manifest.epoch`. Drift breaks determinism. | **Cannot inject a fake clock into the spawned CLI process without src changes**, which is forbidden. Therefore the date-filter spec is **rewritten to NOT compute against a fixed slice**. Instead it asserts **invariants that hold regardless of clock**: (a) clicking `7d` produces total ≤ `goldens.aggregates.totals.cost`, (b) clicking `all` after `7d` restores total to `goldens.aggregates.totals.cost`, (c) clicking `7d` clears any selected project. The original behavioral coverage is preserved; the equality-against-perDay-slice assertion is dropped. |
| R2-S1 | Source filter buttons exist (`SourceFilter` in `App.tsx:716`) when ≥2 sources are detected. | Added a test in `corpus-filters.spec.ts`: when `SourceFilter` shows `>1` button (count via `page.getByRole("button", { name: /^(All Agents|Claude Code|Codex|Eureka|Mars|Copilot)/ })`), clicking a non-`All Agents` source produces a total ≤ `goldens.aggregates.totals.cost`. Skip if `<= 1` source button visible. |

## Resolved blocking issues from Round-1 review

| # | Issue | Resolution |
|---|---|---|
| B1 | `--port 0` not usable: `serve()` returns the *candidate* value (line 68 of `src/server/index.ts`) and `run.ts` line 36 prints `Dashboard → http://localhost:<candidate>`. With candidate=0, the URL is `http://localhost:0`. | Helper pre-binds an ephemeral port via `net.createServer().listen(0)`, reads `address().port`, closes the probe, then passes that explicit number to `--port`. Helper then asserts on the printed URL. |
| B2 | `tokmon serve` does not collect data. Corpus homes contain `.claude/`, `.codex/`, `.craft-agent/`, `.copilot/`, `Library/...marsiwe.db`, etc. — but **no** pre-collected `~/.tokmon/machines/*.json` (default corpus has empty `machines/`; edge corpus has one). The dashboard reads `aggregateData()` which calls `loadMachineData(localMachineId)` — empty unless `collect` ran. | Use the **default top-level command** (`node src/cli/index.ts --no-open --port <N>`), which is `run` (collect → serve). This is what end users get from `tokmon`. The serve subcommand is `hidden` and not what we want. |
| B3 | Specs referenced fictitious `data-testid`s (`session-row-<id>`, `session-detail-modal`, `session-cost`, `model-row-*`). | Use only **real** testids confirmed to exist in source: `total-cost`, `project-leaderboard`, `project-row`, `leaderboard-search-input`, `leaderboard-empty-state`, `leaderboard-pagination`, `project-detail`, `search-input`, `session-table`, `session-row`, `session-pagination`, `session-modal`, `stat-card`, `token-chart`, `burn-clock`, `active-filters-bar`, `project-timeline`. The session detail modal exposes `session-modal` only — header text contains `${project} · ${source} · ${model} · ${formatCurrency(cost)}` so we assert via `getByTestId("session-modal").textContent()` parsing, not per-model rows. |
| B4 | Goldens use `projectKey`/`projectLabel`; design used `name`. | All golden traversals use `project.projectKey` / `project.projectLabel`. UI rows render `project.projectLabel` (per `ProjectActivityTable.tsx:272`), so spec matches against `projectLabel`. |
| B5 | 3 specs insufficient to cover DESIGN-test-harness.md lines 199-209 (filters, leaderboards, search, session-detail). | Five specs: `corpus-dashboard`, `corpus-leaderboard`, `corpus-filters`, `corpus-session-detail`, `corpus-search`. |
| B6 | Deleting `dashboard.spec.ts` would lose: leaderboard search, empty state, clear/reset, selected-project persistence, `7d` filter clears selection. | Migrate **every behavior** from `dashboard.spec.ts` into the corpus-backed specs (mostly into `corpus-search.spec.ts` and `corpus-filters.spec.ts`). Only delete the old spec after verification. |
| S1 | `formatCost` is not exported (App.tsx line 613 — local `formatCurrency`). | Use tolerance comparison: `expect(parseCost(uiText)).toBeCloseTo(golden, 2)`. Helper `parseCost(text)` strips `$` and `,`. |
| S2 | `AggregatesGolden` / `AttributionGolden` already exported from Phase 2 helpers. | Import directly; no shim file. |
| S3 | Need manifest/epoch for date-slice math. | Originally planned date-slice equality, later dropped (see R2-B5). Manifest still loaded for use in unit tests / future-proofing. |
| S4 | TimeFilter button text is lowercase: `all`, `7d`, `30d`, `12m`. | Specs use exact lowercase names. |

## Architecture

```
tests/e2e/
├── helpers/
│   ├── serve-corpus.ts      (NEW)  — boots `node src/cli/index.ts` (default cmd) with TOKMON_HOME=<corpus>/home, returns ephemeral URL
│   ├── corpus-goldens.ts    (NEW)  — loads aggregates.json / sessions.json / attribution.json + manifest
│   └── format.ts            (NEW)  — parseCost(text)→number, formatCostApprox(n)→regex for tolerance matching
├── corpus-dashboard.spec.ts        (NEW)  — totals card matches goldens.totals
├── corpus-leaderboard.spec.ts      (NEW)  — top-N project rows, projectLabel match, selection
├── corpus-filters.spec.ts          (NEW)  — date filter (7d/30d/all/12m) clock-independent invariants + source filter
├── corpus-search.spec.ts           (NEW)  — search-input + leaderboard-search-input behaviors (migrated from dashboard.spec.ts)
├── corpus-session-detail.spec.ts   (NEW)  — click row → session-modal opens with correct header text
└── dashboard.spec.ts               (DELETED at end of phase, after parity is verified)
```

## Server boot helper (B1, B2)

```ts
// tests/e2e/helpers/serve-corpus.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { waitForExit } from "../process.js";

export interface CorpusServer {
  url: string;
  port: number;
  homePath: string;
  close: () => Promise<void>;
}

const READY_REGEX = /Dashboard → (http:\/\/localhost:\d+)/;

async function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        probe.close((err) => (err ? reject(err) : resolve(port)));
      } else {
        probe.close();
        reject(new Error("could not get ephemeral port"));
      }
    });
  });
}

export async function serveCorpus(corpusId: string, opts: { timeoutMs?: number } = {}): Promise<CorpusServer> {
  const homePath = path.resolve(`tests/corpus/snapshots/${corpusId}/home`);
  const port = await pickEphemeralPort();
  // NOTE: the default top-level command (no subcommand) runs collect → serve. Required because corpus homes
  // do not include pre-collected `.tokmon/machines/*.json`. The `serve` subcommand alone would render an
  // empty dashboard.
  const child = spawn(
    "node",
    ["--import", "tsx", "src/cli/index.ts", "--port", String(port), "--no-open"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TOKMON_HOME: homePath,
        // Force the corpus's frozen pricing snapshot. (TOKMON_PRICING_DIR support added in Phase 1 if missing —
        // verify against src/core/config.ts; otherwise rely on TOKMON_HOME causing pricing to be re-fetched
        // and fall back to local cache. The corpus already includes `home/.tokmon/pricing/latest.json`.)
        TOKMON_PRICING_DIR: path.join(homePath, ".tokmon", "pricing"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  const url = await waitForReadyLine(child, opts.timeoutMs ?? 30_000);
  return {
    url,
    port,
    homePath,
    close: async () => {
      child.kill("SIGTERM");
      await waitForExit(child);
    },
  };
}

function waitForReadyLine(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const timer = setTimeout(() => {
      cleanup();
      child.kill("SIGTERM");
      reject(new Error(`tokmon did not print Dashboard URL within ${timeoutMs}ms.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`));
    }, timeoutMs);

    const onStdout = (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const m = stdoutBuf.match(READY_REGEX);
      if (m) {
        cleanup();
        resolve(m[1]);
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`tokmon exited with code ${code} before printing Dashboard URL.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    }
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}
```

**Why `node src/cli/index.ts` (no subcommand):** see `src/cli/index.ts` lines 22–29 — the default command is the `run` action that calls `collectCommand` then `serve()`. Both corpora need collection to populate `~/.tokmon/machines/`. The hidden `serve` subcommand only serves what's already collected and would yield an empty dashboard for the default corpus.

**TOKMON_PRICING_DIR caveat:** if this env is not yet honored, the helper still works because the corpus's `.tokmon/pricing/latest.json` is read by `loadConfig()` via `TOKMON_HOME`. Coder verifies during implementation; if the env hook does not exist, simply drop that env line — no src changes.

## Goldens helper (S2, S3, R2-B4)

```ts
// tests/e2e/helpers/corpus-goldens.ts
import fs from "node:fs/promises";
import path from "node:path";
import { loadCorpus, type Manifest } from "../../corpus/helpers/load-corpus.js";
import type { AggregatesGolden } from "../../corpus/helpers/aggregate-from-sessions.js";
import type { AttributionGolden } from "../../corpus/helpers/build-attribution.js";

export interface CorpusGoldens {
  manifest: Manifest;        // the inner Manifest (id, epoch, fileMtimes?), NOT the full LoadedCorpus wrapper.
  aggregates: AggregatesGolden;
  sessions: unknown;
  attribution: AttributionGolden;
}

export async function loadGoldens(corpusId: string): Promise<CorpusGoldens> {
  const root = path.resolve(`tests/corpus/snapshots/${corpusId}`);
  const loaded = await loadCorpus(corpusId);  // reads manifest.json from disk; pure read, no env mutation
  const [aggregates, sessions, attribution] = await Promise.all([
    fs.readFile(path.join(root, "golden/aggregates.json"), "utf8"),
    fs.readFile(path.join(root, "golden/sessions.json"), "utf8"),
    fs.readFile(path.join(root, "golden/attribution.json"), "utf8"),
  ]);
  return {
    manifest: loaded.manifest,           // <-- unwrap to Manifest
    aggregates: JSON.parse(aggregates) as AggregatesGolden,
    sessions: JSON.parse(sessions),
    attribution: JSON.parse(attribution) as AttributionGolden,
  };
}
```

`loadCorpus` is pure for the manifest read path (lines 26-38 of `load-corpus.ts`); the `withCorpusEnv` function at line 40 is where env mutation lives, and we don't call it.

## Format helper (S1)

```ts
// tests/e2e/helpers/format.ts
export function parseCost(text: string | null): number {
  if (!text) return Number.NaN;
  const cleaned = text.replace(/[$,\s]/g, "").trim();
  return Number.parseFloat(cleaned);
}
```

Specs use `expect(parseCost(...)).toBeCloseTo(golden.cost, 2)` (2-decimal tolerance, matches `$X.XX` rendering).

## Specs

### Common pattern (R2-B1)

```ts
import { test, expect, type Page } from "@playwright/test";
import { serveCorpus, type CorpusServer } from "./helpers/serve-corpus.js";
import { loadGoldens, type CorpusGoldens } from "./helpers/corpus-goldens.js";
import corporaRegistry from "../corpus/corpora.json" assert { type: "json" };
import { parseCost } from "./helpers/format.js";

const CORPUS_IDS = corporaRegistry.corpora.map((c) => c.id); // ["2026-04-default","2026-04-edge"]

// Helper: navigate + switch tab. Initial tab is "overview" (App.tsx:53). Tab labels from App.tsx:644-650.
async function gotoTab(page: Page, url: string, tab: "Overview" | "Projects" | "Sessions" | "Settings") {
  await page.goto(url);
  if (tab !== "Overview") {
    await page.getByRole("button", { name: tab, exact: true }).click();
  }
}

for (const corpusId of CORPUS_IDS) {
  test.describe(`[${corpusId}] dashboard`, () => {
    let server: CorpusServer;
    let goldens: CorpusGoldens;
    test.beforeAll(async () => {
      server = await serveCorpus(corpusId);
      goldens = await loadGoldens(corpusId);
    });
    test.afterAll(async () => {
      await server?.close();
    });
    // tests …
  });
}
```

`fullyParallel: false` (already in `playwright.config.ts`) ensures one describe runs at a time → no `TOKMON_HOME` race.

### corpus-dashboard.spec.ts (Overview tab)

```ts
test("total cost matches goldens.totals.cost", async ({ page }) => {
  await gotoTab(page, server.url, "Overview");
  await page.getByTestId("total-cost").waitFor();
  const ui = await page.getByTestId("total-cost").textContent(); // value div directly contains "$X.XX"
  expect(parseCost(ui)).toBeCloseTo(goldens.aggregates.totals.cost, 2);
});

test("token-chart and burn-clock render", async ({ page }) => {
  await gotoTab(page, server.url, "Overview");
  await expect(page.getByTestId("token-chart")).toBeVisible();
  await expect(page.getByTestId("burn-clock")).toBeVisible();
});
```

### corpus-leaderboard.spec.ts (Projects tab, R2-B2)

```ts
const PAGE_SIZE = 15; // ProjectActivityTable default pageSize

test("project rows render top projects sorted by cost", async ({ page }) => {
  await gotoTab(page, server.url, "Projects");
  await page.getByTestId("project-leaderboard").waitFor();
  const rows = page.locator("[data-testid='project-row']");
  const projects = goldens.aggregates.projects;
  const expectedTop = projects.slice(0, PAGE_SIZE);

  await expect(rows).toHaveCount(Math.min(PAGE_SIZE, projects.length));

  for (const p of expectedTop) {
    await expect(rows.filter({ hasText: p.projectLabel }).first()).toBeVisible();
  }
});

test("clicking a project row populates project-detail", async ({ page }) => {
  await gotoTab(page, server.url, "Projects");
  const target = goldens.aggregates.projects[0]; // highest cost
  await page.locator("[data-testid='project-row']").filter({ hasText: target.projectLabel }).first().click();
  await expect(page.getByTestId("project-detail")).toContainText(target.projectLabel);
});
```

### corpus-filters.spec.ts (R2-B5, R2-S1)

Date and source filters live in the **header**, visible across all tabs. We do not assert numeric equality against a `manifest.epoch`-derived slice (the server uses runtime `Date.now()`, which would drift). Instead we assert behavioral invariants.

```ts
test("7d filter total ≤ All total", async ({ page }) => {
  await gotoTab(page, server.url, "Overview");
  await page.getByTestId("total-cost").waitFor();
  await page.getByRole("button", { name: "7d", exact: true }).click();
  const ui = await page.getByTestId("total-cost").textContent();
  // Allow tiny float epsilon (1e-6) because filtering is monotonic but UI shows 2 decimals.
  expect(parseCost(ui)).toBeLessThanOrEqual(goldens.aggregates.totals.cost + 1e-6);
});

test("'all' filter restores total to goldens.totals.cost", async ({ page }) => {
  await gotoTab(page, server.url, "Overview");
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await page.getByRole("button", { name: "all", exact: true }).click();
  const ui = await page.getByTestId("total-cost").textContent();
  expect(parseCost(ui)).toBeCloseTo(goldens.aggregates.totals.cost, 2);
});

test("7d filter clears any selected project", async ({ page }) => {
  await gotoTab(page, server.url, "Projects");
  const target = goldens.aggregates.projects[0];
  await page.locator("[data-testid='project-row']").filter({ hasText: target.projectLabel }).first().click();
  await expect(page.getByTestId("project-detail")).toContainText(target.projectLabel);
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await expect(page.getByTestId("project-detail")).toContainText("Select a project");
});

test("source filter (when ≥2 sources): non-All total ≤ All total", async ({ page }) => {
  await gotoTab(page, server.url, "Overview");
  await page.getByTestId("total-cost").waitFor();
  // SourceFilter renders a button group only when ≥2 sources detected (App.tsx:744).
  // Identify source buttons by their text — labels come from AGENT_FILTER_LABELS.
  // We probe by looking for "All Agents" + at least one other.
  const allAgents = page.getByRole("button", { name: "All Agents", exact: true });
  if ((await allAgents.count()) === 0) {
    test.skip(true, "single-source corpus — no source filter visible");
  }
  // Click the first non-"All Agents" sibling button in the source group.
  // Use a CSS-near approach: find the parent of "All Agents" then locate sibling buttons.
  const parentGroup = allAgents.locator("xpath=..");
  const siblings = parentGroup.locator("button");
  const total = await siblings.count();
  if (total < 2) test.skip(true, "single source button");
  // First button is "All Agents"; click index 1.
  await siblings.nth(1).click();
  const ui = await page.getByTestId("total-cost").textContent();
  expect(parseCost(ui)).toBeLessThanOrEqual(goldens.aggregates.totals.cost + 1e-6);
});
```

### corpus-search.spec.ts (Sessions + Projects tabs)

Migrates **all** search/clear/empty-state behaviors from the legacy `dashboard.spec.ts`.

```ts
test("session search-input filters session table without changing totals", async ({ page }) => {
  await gotoTab(page, server.url, "Sessions");
  await page.getByTestId("session-table").waitFor();
  const totalBefore = await page.getByTestId("total-cost").textContent();
  await page.fill("[data-testid='search-input']", "zzz-no-such-session");
  await expect(page.locator("[data-testid='session-row']")).toHaveCount(0);
  await expect(page.getByTestId("total-cost")).toHaveText(totalBefore ?? "");
});

test("leaderboard-search-input narrows project rows", async ({ page }) => {
  await gotoTab(page, server.url, "Projects");
  const target = goldens.aggregates.projects[0];
  await page.fill("[data-testid='leaderboard-search-input']", target.projectLabel);
  const rows = page.locator("[data-testid='project-row']");
  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: target.projectLabel })).toBeVisible();
});

test("leaderboard-search-input no-match shows empty state", async ({ page }) => {
  await gotoTab(page, server.url, "Projects");
  await page.fill("[data-testid='leaderboard-search-input']", "zzz-no-match");
  await expect(page.getByTestId("leaderboard-empty-state")).toContainText("No projects match this search.");
});

test("clearing leaderboard-search-input restores rows", async ({ page }) => {
  await gotoTab(page, server.url, "Projects");
  await page.fill("[data-testid='leaderboard-search-input']", "zzz-no-match");
  await page.fill("[data-testid='leaderboard-search-input']", "");
  await expect(page.locator("[data-testid='project-row']").first()).toBeVisible();
});

test("selecting a project then searching unrelated text keeps selection", async ({ page }) => {
  await gotoTab(page, server.url, "Projects");
  const target = goldens.aggregates.projects[0];
  await page.locator("[data-testid='project-row']").filter({ hasText: target.projectLabel }).first().click();
  await expect(page.getByTestId("project-detail")).toContainText(target.projectLabel);
  await page.fill("[data-testid='leaderboard-search-input']", "zzz-no-match");
  await expect(page.getByTestId("project-detail")).toContainText(target.projectLabel);
});
```

### corpus-session-detail.spec.ts (Sessions tab)

```ts
test("clicking a session row opens the session modal with header text", async ({ page }) => {
  await gotoTab(page, server.url, "Sessions");
  await page.getByTestId("session-table").waitFor();
  const rows = page.locator("[data-testid='session-row']:not([data-remote='true'])");
  const count = await rows.count();
  test.skip(count === 0, "corpus has no local (non-remote) sessions");
  await rows.first().click();
  const modal = page.getByTestId("session-modal");
  await expect(modal).toBeVisible();
  // Header format (SessionDetailModal.tsx:120): `${project} · ${source} · ${model} · ${formatCurrency(cost.total)}`
  await expect(modal).toContainText("·");
});
```

## Coverage matrix vs DESIGN-test-harness.md lines 199-209

| DESIGN spec | Phase 3 spec covering it |
|---|---|
| dashboard.spec.ts (totals card) | corpus-dashboard.spec.ts |
| filters.spec.ts (source/project/date) | corpus-filters.spec.ts (date + source-filter invariant), corpus-leaderboard.spec.ts (project select). Model filter UI does not exist as a button group today. |
| leaderboards.spec.ts (top-15 project + model) | corpus-leaderboard.spec.ts (projects). Model leaderboard does not exist as its own UI surface. |
| session-detail.spec.ts (per-model breakdown) | corpus-session-detail.spec.ts (modal opens with header). Per-model rows do not exist in `SessionDetailModal.tsx`. |
| search.spec.ts | corpus-search.spec.ts |

The DESIGN-test-harness.md was written before the UI fully solidified. We cover every actually-rendered surface; non-existent UI surfaces (model leaderboard, model filter buttons) are out of scope for E2E and remain covered by `tests/corpus/aggregation.test.ts`.

## Unit tests (Tier 2)

```
tests/unit/serve-corpus.test.ts     — boots a corpus server, asserts URL matches /^http:\/\/localhost:\d+$/, fetches /api/data and asserts shape
tests/unit/corpus-goldens.test.ts   — loads goldens for each corpus id in corpora.json; asserts totals.cost is finite number, projects is array, attribution has expected keys
```

These give fast feedback on the helpers without requiring Playwright + chromium.

## CI integration

Add to `.github/workflows/ci.yml` after the existing build step:

```yaml
- run: npx playwright install --with-deps chromium
- run: npm run test:e2e
```

`test:e2e` already exists in `package.json`.

## Acceptance criteria

1. `npm run test:e2e` passes locally on macOS and on Ubuntu CI.
2. New specs reference goldens, **never hardcoded numbers**.
3. Both `2026-04-default` and `2026-04-edge` are exercised by every new spec via the `for` loop.
4. **No production code changes** outside test wiring.
5. `dashboard.spec.ts` deleted only after all migrated behaviors pass in the new specs.
6. `serve-corpus.ts` fails with a clear error message containing captured stdout+stderr if the CLI does not print the Dashboard URL within 30 s.
7. CI workflow updated with `playwright install` + `test:e2e` step.

## File inventory

**NEW (test-side only):**
- `tests/e2e/helpers/serve-corpus.ts`
- `tests/e2e/helpers/corpus-goldens.ts`
- `tests/e2e/helpers/format.ts`
- `tests/e2e/corpus-dashboard.spec.ts`
- `tests/e2e/corpus-leaderboard.spec.ts`
- `tests/e2e/corpus-filters.spec.ts`
- `tests/e2e/corpus-search.spec.ts`
- `tests/e2e/corpus-session-detail.spec.ts`
- `tests/unit/serve-corpus.test.ts`
- `tests/unit/corpus-goldens.test.ts`

**MODIFIED:**
- `.github/workflows/ci.yml` — add `playwright install` + `test:e2e` step.

**DELETED (only after migrated specs pass):**
- `tests/e2e/dashboard.spec.ts`

**UNCHANGED:**
- All `src/**` files
- `tests/corpus/**` (Phase 1+2 tests)
- `tests/unit/parsers/**` (Phase 1 tests)
- `package.json` (scripts already in place)
- `playwright.config.ts` (`fullyParallel: false`, `headless: true`)

## Test strategy summary

- **Unit (vitest):** helpers (`serve-corpus`, `corpus-goldens`) — fast, no browser, no chromium dep.
- **E2E (playwright):** five `corpus-*.spec.ts` files, each iterating both corpora via top-level `for` loop. `fullyParallel: false` serializes describes → no TOKMON_HOME race.
- **Determinism:** ephemeral port per server, explicit `TOKMON_HOME` per spawn, child killed in `afterAll`. Goldens are JSON; tolerance comparison for floats. Date-filter assertions use clock-independent invariants (monotonic + round-trip) rather than equality against a fixed slice — prevents corpus-staleness drift.
- **Edge cases verified:**
  - 7d filter total ≤ all-time total (monotonic, clock-independent).
  - Corpus with no local sessions → `corpus-session-detail.spec.ts` uses `test.skip(count === 0, …)`.
  - Single-source corpus → `corpus-filters.spec.ts` source-filter test uses `test.skip` when no `All Agents` button is rendered.
  - Edge corpus orphan eureka session → already covered by `tests/corpus/attribution.test.ts`; the UI just renders the session row, asserted by leaderboard count assertions.
