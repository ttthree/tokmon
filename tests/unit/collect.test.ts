import fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectCommand } from "../../src/cli/commands/collect.js";
import { PARSER_SCHEMA_VERSION } from "../../src/core/cursor.js";
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

  it("refreshes stale parser schema cursors to backfill parser output changes", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeFixture(testHome);
    const result = await collectCommand({ silent: true });
    expect(result.sessionCount).toBe(1);
    const machineFiles = await fs.readdir(`${testHome}/.tokmon/machines`);
    const machinePath = `${testHome}/.tokmon/machines/${machineFiles[0]}`;
    const machine = JSON.parse(await fs.readFile(machinePath, "utf8"));
    machine._cursor.parserSchemaVersion = 1;
    const firstSession = Object.values(machine.sessions)[0] as { usageEvents?: unknown };
    delete firstSession.usageEvents;
    await fs.writeFile(machinePath, JSON.stringify(machine), "utf8");

    await collectCommand({ silent: true });
    const updated = JSON.parse(await fs.readFile(machinePath, "utf8"));

    expect(updated._cursor.parserSchemaVersion).toBe(PARSER_SCHEMA_VERSION);
    expect(Object.values(updated.sessions)[0]).toHaveProperty("usageEvents");
  });
});
