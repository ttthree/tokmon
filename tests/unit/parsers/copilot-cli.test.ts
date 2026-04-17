import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createCopilotFixture, createTestHome } from "../../helpers/fixtures.js";
import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { copilotCliParser } from "../../../src/parsers/copilot-cli.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("copilot parser", () => {
  it("normalizes both telemetry formats", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createCopilotFixture(testHome);
    const result = await copilotCliParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].turns).toBe(2);
    expect(result.sessions[0].tokens.input).toBe(175);
    expect(result.sessions[0].tokens.output).toBe(35);
  });

  it("merges one session across multiple log files", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createCopilotFixture(testHome, "process-001.log");
    await createCopilotFixture(testHome, "process-002.log");
    const result = await copilotCliParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].tokens.input).toBe(350);
    expect(result.sessions[0].tokens.output).toBe(70);
    expect(result.sessions[0].turns).toBe(4);
  });
});
