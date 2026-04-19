import { test, expect } from "@playwright/test";

import corporaRegistry from "../corpus/corpora.json" assert { type: "json" };
import { loadGoldens, type CorpusGoldens } from "./helpers/corpus-goldens.js";
import { parseCost } from "./helpers/format.js";
import { gotoTab } from "./helpers/navigation.js";
import { serveCorpus, type CorpusServer } from "./helpers/serve-corpus.js";

const CORPUS_IDS = corporaRegistry.corpora.map((corpus) => corpus.id);

for (const corpusId of CORPUS_IDS) {
  test.describe(`[${corpusId}] corpus-filters`, () => {
    let server: CorpusServer;
    let goldens: CorpusGoldens;

    test.beforeAll(async () => {
      server = await serveCorpus(corpusId);
      goldens = await loadGoldens(corpusId);
    });

    test.afterAll(async () => {
      await server?.close();
    });

    test("7d filter total <= all total", async ({ page }) => {
      await gotoTab(page, server.url, "Overview");
      await page.getByRole("button", { name: "all", exact: true }).click();
      await page.getByTestId("total-cost").waitFor();
      await page.getByRole("button", { name: "7d", exact: true }).click();
      const uiText = await page.getByTestId("total-cost").textContent();
      expect(parseCost(uiText)).toBeLessThanOrEqual(goldens.aggregates.totals.cost.total + 1e-6);
    });

    test("all filter restores total to golden total", async ({ page }) => {
      await gotoTab(page, server.url, "Overview");
      await page.getByRole("button", { name: "7d", exact: true }).click();
      await page.getByRole("button", { name: "all", exact: true }).click();
      await expect
        .poll(async () => parseCost(await page.getByTestId("total-cost").textContent()), { timeout: 20_000 })
        .toBeCloseTo(goldens.aggregates.totals.cost.total, 2);
    });

    test("7d filter clears selected project", async ({ page }) => {
      await gotoTab(page, server.url, "Projects");
      await page.getByRole("button", { name: "all", exact: true }).click();

      test.skip(goldens.aggregates.projects.length === 0, "corpus has no projects");
      await expect
        .poll(async () => await page.locator("[data-testid='project-row']").count(), { timeout: 20_000 })
        .toBeGreaterThan(0);

      const firstRow = page.locator("[data-testid='project-row']").first();
      const selectedLabel = ((await firstRow.locator("td span").nth(1).textContent()) ?? "").trim();
      await firstRow.click();
      expect(selectedLabel.length).toBeGreaterThan(0);
      await expect(page.getByTestId("project-detail")).toContainText(selectedLabel);

      await page.getByRole("button", { name: "7d", exact: true }).click();
      const selectedRowVisible = await page
        .locator("[data-testid='project-row']")
        .filter({ hasText: selectedLabel })
        .first()
        .isVisible()
        .catch(() => false);
      const detail = page.getByTestId("project-detail");
      if (selectedRowVisible) {
        const detailText = (await detail.textContent()) ?? "";
        expect(detailText.includes(selectedLabel) || detailText.includes("Select a project")).toBe(true);
      } else {
        await expect(detail).toContainText("Select a project");
      }
    });

    test("source filter when available has total <= all-agents total", async ({ page }) => {
      await gotoTab(page, server.url, "Overview");
      await page.getByRole("button", { name: "all", exact: true }).click();
      await page.getByTestId("total-cost").waitFor();

      const allAgents = page.getByRole("button", { name: "All Agents", exact: true });
      test.skip((await allAgents.count()) === 0, "single-source corpus has no source button group");

      const siblings = allAgents.locator("xpath=../button");
      test.skip((await siblings.count()) < 2, "no non-all source buttons available");

      await siblings.nth(1).click();
      const uiText = await page.getByTestId("total-cost").textContent();
      expect(parseCost(uiText)).toBeLessThanOrEqual(goldens.aggregates.totals.cost.total + 1e-6);
    });
  });
}
