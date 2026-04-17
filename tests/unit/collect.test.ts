import fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectCommand } from "../../src/cli/commands/collect.js";
import { createClaudeFixture, createTestHome } from "../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  vi.restoreAllMocks();
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("collectCommand", () => {
  it("returns a structured result without printing", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeFixture(testHome);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await collectCommand({ silent: true });

    expect(result.sessionCount).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
