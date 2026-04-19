import { test, expect } from "@playwright/test";

import corporaRegistry from "../corpus/corpora.json" with { type: "json" };
import { loadGoldens, type CorpusGoldens } from "./helpers/corpus-goldens.js";
import { gotoTab } from "./helpers/navigation.js";
import { serveCorpus, type CorpusServer } from "./helpers/serve-corpus.js";

const CORPUS_IDS = corporaRegistry.corpora.map((corpus) => corpus.id);

for (const corpusId of CORPUS_IDS) {
  test.describe(`[${corpusId}] corpus-session-detail`, () => {
    let server: CorpusServer;
    let goldens: CorpusGoldens;

    test.beforeAll(async () => {
      server = await serveCorpus(corpusId);
      goldens = await loadGoldens(corpusId);
    });

    test.afterAll(async () => {
      await server?.close();
    });

    test("clicking a session row opens the session modal", async ({ page }) => {
      await gotoTab(page, server.url, "Sessions");
      await page.getByTestId("session-table").waitFor();

      test.skip(goldens.aggregates.totals.sessions === 0, "corpus has no sessions");
      const rows = page.locator("[data-testid='session-row']");
      await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);

      await rows.first().click();
      const modal = page.getByTestId("session-modal");
      await expect(modal).toBeVisible();
      await expect(modal).toContainText("·");
    });
  });
}
