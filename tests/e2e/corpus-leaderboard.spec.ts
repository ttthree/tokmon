import { test, expect } from "@playwright/test";

import corporaRegistry from "../corpus/corpora.json" with { type: "json" };
import { loadGoldens, type CorpusGoldens } from "./helpers/corpus-goldens.js";
import { gotoTab } from "./helpers/navigation.js";
import { serveCorpus, type CorpusServer } from "./helpers/serve-corpus.js";

const CORPUS_IDS = corporaRegistry.corpora.map((corpus) => corpus.id);
const PAGE_SIZE = 15;

for (const corpusId of CORPUS_IDS) {
  test.describe(`[${corpusId}] corpus-leaderboard`, () => {
    let server: CorpusServer;
    let goldens: CorpusGoldens;

    test.beforeAll(async () => {
      server = await serveCorpus(corpusId);
      goldens = await loadGoldens(corpusId);
    });

    test.afterAll(async () => {
      await server?.close();
    });

    test("project rows render top projects sorted by cost", async ({ page }) => {
      await gotoTab(page, server.url, "Projects");
      await page.getByRole("button", { name: "all", exact: true }).click();
      await page.getByTestId("project-leaderboard").waitFor();

      const projects = goldens.aggregates.projects;
      test.skip(projects.length === 0, "corpus has no projects");

      const rows = page.locator("[data-testid='project-row']");
      await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await expect(rows).toHaveCount(Math.min(PAGE_SIZE, projects.length));

      const expectedTop = projects.slice(0, PAGE_SIZE);
      for (const project of expectedTop) {
        await expect(rows.filter({ hasText: project.projectLabel }).first()).toBeVisible();
      }
    });

    test("clicking a project row populates project-detail", async ({ page }) => {
      await gotoTab(page, server.url, "Projects");
      await page.getByRole("button", { name: "all", exact: true }).click();

      const target = goldens.aggregates.projects[0];
      test.skip(!target, "corpus has no projects");

      const rows = page.locator("[data-testid='project-row']");
      await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await page.locator("[data-testid='project-row']").filter({ hasText: target.projectLabel }).first().click();
      await expect(page.getByTestId("project-detail")).toContainText(target.projectLabel);
    });
  });
}
