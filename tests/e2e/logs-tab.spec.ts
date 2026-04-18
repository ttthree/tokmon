import { test, expect } from "@playwright/test";

import corporaRegistry from "../corpus/corpora.json" assert { type: "json" };
import { serveCorpus, type CorpusServer } from "./helpers/serve-corpus.js";

const CORPUS_ID = corporaRegistry.corpora[0]?.id;

test.describe(`[${CORPUS_ID}] logs tab`, () => {
  let server: CorpusServer;

  test.beforeAll(async () => {
    server = await serveCorpus(CORPUS_ID);
  });

  test.afterAll(async () => {
    await server?.close();
  });

  test("renders Logs tab with empty state and clear control", async ({ page }) => {
    await page.goto(server.url);
    // Wait for initial dashboard data.
    await page.getByTestId("total-cost").waitFor();
    // Click the Logs tab.
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    // The empty state should be visible (no deltas have been observed yet).
    await expect(page.getByTestId("logs-empty")).toBeVisible();
    // Clear button is rendered but disabled while empty.
    const clear = page.getByTestId("logs-clear");
    await expect(clear).toBeVisible();
    await expect(clear).toBeDisabled();
  });
});
