import type { Page } from "@playwright/test";

export type DashboardTab = "Overview" | "Projects" | "Sessions" | "Settings";

const ROUTES_INSTALLED = new WeakSet<Page>();

async function installStableRoutes(page: Page): Promise<void> {
  if (ROUTES_INSTALLED.has(page)) return;
  ROUTES_INSTALLED.add(page);

  await page.route("**/api/machine", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "Jies-MacBook-Pro-2.local-262d02",
        hostname: "Jies-MacBook-Pro-2.local",
        name: "Jies-MacBook-Pro-2.local",
      }),
    });
  });

  await page.route("**/api/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        github: { repo: "", branch: "main" },
        privacy: {
          sync: {
            includeSummary: false,
            includeFirstPrompt: false,
            includeProjectPath: false,
            includeProjectName: true,
            includeOrchestratorMetadata: true,
          },
        },
        projects: {},
        excludeFolders: [],
        pricing: { autoUpdate: false, updateIntervalHours: 24 },
        sources: [],
        machine: {},
      }),
    });
  });
}

export async function gotoTab(page: Page, url: string, tab: DashboardTab): Promise<void> {
  await installStableRoutes(page);
  await page.goto(url);
  if (tab !== "Overview") {
    await page.getByRole("button", { name: tab, exact: true }).click();
  }
}
