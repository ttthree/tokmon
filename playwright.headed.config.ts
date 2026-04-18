import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  use: {
    headless: false,
    viewport: { width: 1440, height: 900 },
    launchOptions: { slowMo: 600 },
    actionTimeout: 30000,
  },
});
