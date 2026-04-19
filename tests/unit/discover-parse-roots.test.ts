import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../src/core/cursor.js";
import { discoverParseRoots } from "../../src/core/parse-roots.js";
import { createTestHome } from "../helpers/fixtures.js";
import { createMarsAgentConfigRoots, marsAppDirForTest } from "../helpers/mars-fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("discoverParseRoots", () => {
  it("enumerates Mars app-support agent-config roots", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    const roots = await createMarsAgentConfigRoots(testHome);

    const discovered = await discoverParseRoots({ machineId: "m1", existingCursor: createEmptyCursorState() });

    expect(discovered).toEqual({
      claudeRoots: [roots.claude],
      codexRoots: [roots.codex],
      copilotRoots: [roots.copilot],
    });
  });

  it("honors configured mars sources and skips missing dirs", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const configuredAppDir = marsAppDirForTest(testHome, "com.marsiwe.app.dev");
    const roots = await createMarsAgentConfigRoots(testHome, "com.marsiwe.app.dev");

    const discovered = await discoverParseRoots({
      machineId: "m1",
      existingCursor: createEmptyCursorState(),
      sources: [
        { id: `mars:${configuredAppDir}`, type: "mars", path: configuredAppDir, enabled: true, autoDetected: false },
        { id: "mars:/missing", type: "mars", path: "/missing", enabled: true, autoDetected: false },
      ],
    });

    expect(discovered).toEqual({
      claudeRoots: [roots.claude],
      codexRoots: [roots.codex],
      copilotRoots: [roots.copilot],
    });
  });
});
