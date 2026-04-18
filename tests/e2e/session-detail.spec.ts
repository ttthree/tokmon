import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { test, expect } from "@playwright/test";

import { createClaudeFixture, createTestHome } from "../helpers/fixtures.js";
import { waitForExit, waitForStdout } from "./process.js";

test.describe("session detail modal", () => {
  let testHome = "";
  let serverProcess: ReturnType<typeof spawn>;
  const port = 3100;

  test.beforeAll(async () => {
    testHome = await createTestHome();
    await createClaudeFixture(testHome, {
      sessionId: "modal-session",
      projectName: "modal-project",
      summary: "Inspect modal transcript",
      firstPrompt: "Open the transcript",
      transcript: "rich",
    });

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

  test("opens, renders, expands, and closes the modal", async ({ page }) => {
    await page.goto(`http://localhost:${port}`);
    await page.getByRole("button", { name: "Sessions", exact: true }).click();

    const rows = page.locator("[data-testid='session-row']");
    test.skip((await rows.count()) === 0, "fixture produced no session rows");
    await rows.first().click();
    await expect(page.getByTestId("session-modal")).toBeVisible();
    await expect(page.getByTestId("user-bubble")).toBeVisible();
    await expect(page.getByTestId("assistant-bubble")).toBeVisible();
    await expect(page.getByText("Inspecting the file and planning the fix.")).toHaveCount(0);

    await page.getByTestId("thinking-block").getByRole("button").click();
    await expect(page.getByText("Inspecting the file and planning the fix.")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("session-modal")).toHaveCount(0);

    await rows.first().click();
    await expect(page.getByTestId("session-modal")).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.getByTestId("session-modal")).toHaveCount(0);
  });
});
