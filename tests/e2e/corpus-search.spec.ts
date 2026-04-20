import { test, expect } from "@playwright/test";

import corporaRegistry from "../corpus/corpora.json" with { type: "json" };
import { loadGoldens, type CorpusGoldens } from "./helpers/corpus-goldens.js";
import { parseCost } from "./helpers/format.js";
import { gotoTab } from "./helpers/navigation.js";
import { serveCorpus, type CorpusServer } from "./helpers/serve-corpus.js";

const CORPUS_IDS = corporaRegistry.corpora.map((corpus) => corpus.id);

for (const corpusId of CORPUS_IDS) {
  test.describe(`[${corpusId}] corpus-search`, () => {
    let server: CorpusServer;
    let goldens: CorpusGoldens;

    test.beforeAll(async () => {
      server = await serveCorpus(corpusId);
      goldens = await loadGoldens(corpusId);
    });

    test.afterAll(async () => {
      await server?.close();
    });

    test("session search filters rows and keeps total unchanged", async ({ page }) => {
      await gotoTab(page, server.url, "Overview");
      await page.getByRole("button", { name: "all", exact: true }).click();
      await page.getByTestId("total-cost").waitFor();
      if (goldens.aggregates.totals.cost.total > 0.01) {
        await expect
          .poll(async () => parseCost(await page.getByTestId("total-cost").textContent()), { timeout: 20_000 })
          .toBeGreaterThan(0);
      }
      const totalBefore = parseCost(await page.getByTestId("total-cost").textContent());
      expect(Number.isFinite(totalBefore)).toBe(true);

      await page.getByRole("button", { name: "Sessions", exact: true }).click();
      await page.getByTestId("session-table").waitFor();
      await page.fill("[data-testid='search-input']", "zzz-no-such-session");
      await expect(page.locator("[data-testid='session-row']")).toHaveCount(0);

      await page.getByRole("button", { name: "Overview", exact: true }).click();
      const totalAfter = parseCost(await page.getByTestId("total-cost").textContent());
      expect(totalAfter).toBeCloseTo(totalBefore, 2);
    });

    test("leaderboard search narrows project rows", async ({ page }) => {
      await gotoTab(page, server.url, "Projects");
      await page.getByRole("button", { name: "all", exact: true }).click();
      test.skip(goldens.aggregates.projects.length === 0, "corpus has no projects");

      const firstRow = page.locator("[data-testid='project-row']").first();
      const rows = page.locator("[data-testid='project-row']");
      await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
      const rowCount = await rows.count();
      const targetLabel = ((await firstRow.locator("td span").nth(1).textContent()) ?? "").trim();
      expect(targetLabel.length).toBeGreaterThan(0);

      await page.fill("[data-testid='leaderboard-search-input']", targetLabel);
      const afterCount = await rows.count();
      expect(afterCount).toBeLessThanOrEqual(rowCount);
      if (afterCount > 0) {
        await expect(rows.filter({ hasText: targetLabel }).first()).toBeVisible();
      }
    });

    test("leaderboard no-match shows empty state", async ({ page }) => {
      await gotoTab(page, server.url, "Projects");
      await page.getByRole("button", { name: "all", exact: true }).click();
      await page.fill("[data-testid='leaderboard-search-input']", "zzz-no-match");
      await expect(page.getByTestId("leaderboard-empty-state")).toContainText("No projects match this search.");
    });

    test("clearing leaderboard search restores rows", async ({ page }) => {
      await gotoTab(page, server.url, "Projects");
      await page.getByRole("button", { name: "all", exact: true }).click();
      const rows = page.locator("[data-testid='project-row']");
      test.skip(goldens.aggregates.projects.length === 0, "corpus has no projects");
      await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
      const baseCount = await rows.count();
      await page.fill("[data-testid='leaderboard-search-input']", "zzz-no-match");
      await page.fill("[data-testid='leaderboard-search-input']", "");
      await expect(rows).toHaveCount(baseCount);
    });

    test("project selection persists through unrelated leaderboard search", async ({ page }) => {
      await gotoTab(page, server.url, "Projects");
      await page.getByRole("button", { name: "all", exact: true }).click();
      test.skip(goldens.aggregates.projects.length === 0, "corpus has no projects");

      const firstRow = page.locator("[data-testid='project-row']").first();
      await expect
        .poll(async () => await page.locator("[data-testid='project-row']").count(), { timeout: 20_000 })
        .toBeGreaterThan(0);
      const targetLabel = ((await firstRow.locator("td span").nth(1).textContent()) ?? "").trim();
      expect(targetLabel.length).toBeGreaterThan(0);

      await firstRow.click();
      await expect(page.getByTestId("project-detail")).toContainText(targetLabel);

      await page.fill("[data-testid='leaderboard-search-input']", "zzz-no-match");
      await expect(page.getByTestId("project-detail")).toContainText(targetLabel);
    });
  });
}
