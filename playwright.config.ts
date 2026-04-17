import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
});
