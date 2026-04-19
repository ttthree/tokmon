import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { buildMarsRegistry } from "../../../src/parsers/mars.js";
import { createMarsDbFixture, marsAppDirForTest } from "../../helpers/mars-fixtures.js";
import { createTestHome } from "../../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("buildMarsRegistry", () => {
  it("returns an empty registry when the db is missing", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const registry = await buildMarsRegistry({ machineId: "m1", existingCursor: createEmptyCursorState() });

    expect(registry.byAgentSessionId.claudeCode.size).toBe(0);
    expect(registry.byAgentSessionId.codex.size).toBe(0);
    expect(registry.byAgentSessionId.copilotCli.size).toBe(0);
  });

  it("normalizes agent types, skips invalid rows, and supports orphan tasks", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createMarsDbFixture({
      homeDir: testHome,
      workspaces: [{ idHex: "11111111111111111111111111111111", name: "ws", path: "/tmp/ws" }],
      tasks: [{ idHex: "22222222222222222222222222222222", workspaceIdHex: "11111111111111111111111111111111", title: "Task 1", status: "inprogress" }],
      sessions: [
        { idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "claude_code", agentSessionId: "cc-1", name: "coder" },
        { idHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "codex-cli", agentSessionId: "cx-1" },
        { idHex: "cccccccccccccccccccccccccccccccc", workspaceIdHex: "11111111111111111111111111111111", agentType: "copilot-cli", agentSessionId: "cp-1" },
        { idHex: "dddddddddddddddddddddddddddddddd", workspaceIdHex: "11111111111111111111111111111111", agentType: "unknown", agentSessionId: "x-1" },
        { idHex: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", workspaceIdHex: "11111111111111111111111111111111", agentType: "claude-code", agentSessionId: undefined },
      ],
    });

    const registry = await buildMarsRegistry({ machineId: "m1", existingCursor: createEmptyCursorState() });

    expect(registry.byAgentSessionId.claudeCode.has("cc-1")).toBe(true);
    expect(registry.byAgentSessionId.codex.has("cx-1")).toBe(true);
    expect(registry.byAgentSessionId.copilotCli.has("cp-1")).toBe(true);
    expect(registry.byAgentSessionId.claudeCode.has("x-1")).toBe(false);
    expect(registry.byAgentSessionId.claudeCode.get("cc-1")?.taskTitle).toBe("Task 1");
    expect(registry.byAgentSessionId.copilotCli.get("cp-1")?.taskTitle).toBeUndefined();
  });

  it("merges stable and dev db rows by latest updatedAt", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createMarsDbFixture({
      homeDir: testHome,
      appId: "com.marsiwe.app",
      sessions: [{ idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agentType: "claude-code", agentSessionId: "dup", name: "old", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    await createMarsDbFixture({
      homeDir: testHome,
      appId: "com.marsiwe.app.dev",
      sessions: [{ idHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agentType: "claude-code", agentSessionId: "dup", name: "new", updatedAt: "2026-02-01T00:00:00.000Z" }],
    });

    const registry = await buildMarsRegistry({ machineId: "m1", existingCursor: createEmptyCursorState() });
    expect(registry.byAgentSessionId.claudeCode.get("dup")?.sessionName).toBe("new");
  });

  it("handles empty db files without throwing", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    const appDir = marsAppDirForTest(testHome, "com.marsiwe.app");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "marsiwe.db"), "", "utf8");

    await expect(buildMarsRegistry({ machineId: "m1", existingCursor: createEmptyCursorState() })).resolves.toEqual({
      byAgentSessionId: {
        claudeCode: new Map(),
        codex: new Map(),
        copilotCli: new Map(),
      },
    });
  });
});
