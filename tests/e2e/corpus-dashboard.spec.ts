import { test, expect, type Page } from "@playwright/test";

import corporaRegistry from "../corpus/corpora.json" with { type: "json" };
import { loadGoldens, type CorpusGoldens } from "./helpers/corpus-goldens.js";
import { parseCost } from "./helpers/format.js";
import { serveCorpus, type CorpusServer } from "./helpers/serve-corpus.js";

const CORPUS_IDS = corporaRegistry.corpora.map((corpus) => corpus.id);

async function gotoTab(page: Page, url: string, tab: "Overview" | "Projects" | "Sessions" | "Settings"): Promise<void> {
  await page.goto(url);
  if (tab !== "Overview") {
    await page.getByRole("button", { name: tab, exact: true }).click();
  }
}

for (const corpusId of CORPUS_IDS) {
  test.describe(`[${corpusId}] corpus-dashboard`, () => {
    let server: CorpusServer;
    let goldens: CorpusGoldens;

    test.beforeAll(async () => {
      server = await serveCorpus(corpusId);
      goldens = await loadGoldens(corpusId);
    });

    test.afterAll(async () => {
      await server?.close();
    });

    test("total cost matches goldens.totals.cost", async ({ page }) => {
      await gotoTab(page, server.url, "Overview");
      await page.getByRole("button", { name: "all", exact: true }).click();
      await page.getByTestId("total-cost").waitFor();
      const uiText = await page.getByTestId("total-cost").textContent();
      const uiTotal = parseCost(uiText);
      expect(Number.isFinite(uiTotal)).toBe(true);
      expect(uiTotal).toBeLessThanOrEqual(goldens.aggregates.totals.cost.total + 1e-6);
    });

    test("token-chart and burn-clock render", async ({ page }) => {
      await gotoTab(page, server.url, "Overview");
      await expect(page.getByTestId("token-chart")).toBeVisible();
      await expect(page.getByTestId("burn-clock")).toBeVisible();
    });
  });
}
