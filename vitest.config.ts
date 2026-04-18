import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/e2e/**/*.test.ts", "tests/corpus/**/*.test.ts"],
    globalSetup: ["tests/corpus/global-setup.ts"],
  },
});
