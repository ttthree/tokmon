import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseAllPure } from "../../../src/cli/commands/corpus/parse-pure.js";
import { createClaudeFixture, createTestHome } from "../../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("parseAllPure", () => {
  it("returns sessions without writing machine data files", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeFixture(testHome);

    const sessions = await parseAllPure({ forceAllSources: true });
    expect(sessions.length).toBeGreaterThan(0);

    const machinesDir = path.join(testHome, ".tokmon", "machines");
    const entries = await fs.readdir(machinesDir).catch(() => [] as string[]);
    expect(entries).toHaveLength(0);
  });
});

