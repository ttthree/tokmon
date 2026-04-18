import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/e2e/**/*.test.ts", "tests/corpus/**/*.test.ts"],
    globalSetup: ["tests/corpus/global-setup.ts"],
    // Windows runners (especially with 3 concurrent workers each touching
    // the corpus tree) parse the default corpus noticeably slower than
    // macOS/Linux. Bump the per-test/hook timeout so corpus suites have
    // headroom on Windows.
    testTimeout: 90000,
    hookTimeout: 90000,
  },
});
