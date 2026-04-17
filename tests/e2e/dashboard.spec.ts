import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { test, expect } from "@playwright/test";

import { createClaudeFixture, createTestHome } from "../helpers/fixtures.js";
import { waitForExit, waitForStdout } from "./process.js";

test.describe("dashboard", () => {
  let testHome = "";
  let serverProcess: ReturnType<typeof spawn>;
  const port = 3099;

  test.beforeAll(async () => {
    testHome = await createTestHome();
    await createClaudeFixture(testHome, {
      sessionId: "alpha-auth",
      projectName: "alpha-project",
      summary: "Fixed auth bug",
      firstPrompt: "Investigate auth issue",
      ageDays: 3,
      inputTokens: 1200,
      outputTokens: 600,
    });
    await createClaudeFixture(testHome, {
      sessionId: "alpha-billing",
      projectName: "alpha-project",
      summary: "Updated billing flow",
      firstPrompt: "Refactor billing service",
      ageDays: 2,
      inputTokens: 900,
      outputTokens: 400,
    });
    await createClaudeFixture(testHome, {
      sessionId: "beta-legacy",
      projectName: "beta-project",
      summary: "Legacy migration patch",
      firstPrompt: "Audit migration issue",
      ageDays: 20,
      inputTokens: 3000,
      outputTokens: 1200,
    });

    for (let index = 1; index <= 11; index += 1) {
      await createClaudeFixture(testHome, {
        sessionId: `delta-${index}`,
        projectName: `delta-${String(index).padStart(2, "0")}`,
        summary: `Fixture project ${index}`,
        firstPrompt: `Inspect fixture ${index}`,
        ageDays: 1,
        inputTokens: index * 10,
        outputTokens: index * 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      });
    }

    serverProcess = spawn("node", ["--import", "tsx", "src/cli/index.ts", "--port", String(port), "--no-open"], {
      cwd: process.cwd(),
      env: { ...process.env, TOKMON_HOME: testHome },
      stdio: "pipe",
    });

    await waitForStdout(serverProcess, `Dashboard → http://localhost:${port}`);
  });

  test.afterAll(async () => {
    serverProcess?.kill("SIGTERM");
    await waitForExit(serverProcess);
    if (testHome) {
      await fs.rm(testHome, { recursive: true, force: true });
    }
  });

  test("supports the project-centric dashboard workflow", async ({ page }) => {
    await page.goto(`http://localhost:${port}`);

    await page.waitForSelector("[data-testid='project-leaderboard']");
    await expect(page.locator("[data-testid='project-row']")).toHaveCount(10);
    await expect(page.locator("[data-testid='project-row']").filter({ hasText: "alpha-project" })).toBeVisible();
    await expect(page.locator("[data-testid='project-row']").filter({ hasText: "beta-project" })).toBeVisible();
    await expect(page.locator("[data-testid='project-row']").filter({ hasText: "delta-01" })).toHaveCount(0);

    const totalCostBeforeSearch = await page.getByTestId("total-cost").textContent();

    await page.locator("[data-testid='project-row']").filter({ hasText: "beta-project" }).click();

    await expect(page.getByTestId("project-detail")).toContainText("beta-project");
    await expect(page.getByTestId("source-breakdown")).toBeVisible();
    await expect(page.getByTestId("selected-model-breakdown")).toBeVisible();
    await expect(page.getByTestId("machine-breakdown")).toBeVisible();
    await expect(page.locator("[data-testid='project-breakdown']")).toHaveCount(0);
    await expect(page.locator("[data-testid='session-row']")).toHaveCount(1);
    await expect(page.locator("[data-testid='session-row']").first()).toContainText("beta-project");

    await page.fill("[data-testid='search-input']", "auth");
    await expect(page.locator("[data-testid='session-row']")).toHaveCount(0);
    await expect(page.getByTestId("total-cost")).toHaveText(totalCostBeforeSearch ?? "");
    await expect(page.locator("[data-testid='project-row']")).toHaveCount(10);

    await page.fill("[data-testid='leaderboard-search-input']", "delta-01");
    await expect(page.locator("[data-testid='project-row']")).toHaveCount(1);
    await expect(page.locator("[data-testid='project-row']").filter({ hasText: "delta-01" })).toBeVisible();
    await expect(page.locator("[data-testid='project-row']").filter({ hasText: "beta-project" })).toHaveCount(0);
    await expect(page.getByTestId("project-detail")).toContainText("beta-project");
    await expect(page.locator("[data-testid='session-row']")).toHaveCount(0);

    await page.fill("[data-testid='leaderboard-search-input']", "zzz-no-match");
    await expect(page.getByTestId("leaderboard-empty-state")).toContainText("No projects match this search.");
    await expect(page.getByTestId("project-detail")).toContainText("beta-project");

    await page.fill("[data-testid='leaderboard-search-input']", "");

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByTestId("project-detail")).toContainText("Select a project to inspect cost drivers.");
    await expect(page.locator("[data-testid='project-breakdown']")).toBeVisible();

    await page.locator("[data-testid='project-row']").filter({ hasText: "beta-project" }).click();
    await expect(page.getByTestId("project-detail")).toContainText("beta-project");
    await page.getByRole("button", { name: "7d" }).click();
    await expect(page.getByTestId("project-detail")).toContainText("Select a project to inspect cost drivers.");
    await expect(page.locator("[data-testid='project-row']")).toHaveCount(10);
    await expect(page.locator("[data-testid='project-row']").filter({ hasText: "alpha-project" })).toBeVisible();
  });
});
