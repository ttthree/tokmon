import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createCodexFixture, createTestHome } from "../../helpers/fixtures.js";
import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { codexParser } from "../../../src/parsers/codex.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("codex parser", () => {
  it("reads sessions and tool counts from sqlite", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createCodexFixture(testHome);
    const result = await codexParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].toolCallCount).toBe(0);
    expect(result.sessions[0].tokens.input).toBe(0);
    expect(result.sessions[0].tokens.output).toBe(0);
  });
});
