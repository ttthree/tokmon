import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { marsParser, marsRegistry } from "../../../src/parsers/mars.js";
import { createMarsAgentConfigRoots, createMarsDbFixture } from "../../helpers/mars-fixtures.js";
import { createTestHome } from "../../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("mars parser", () => {
  it("returns empty registry when DB is missing", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const result = await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toEqual([]);
    expect(marsRegistry.byAgentSessionId.claudeCode.size).toBe(0);
  });

  it("handles empty DB file without throwing", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    const appDir = path.join(testHome, "Library", "Application Support", "com.marsiwe.app");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "marsiwe.db"), "", "utf8");

    await expect(marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() })).resolves.toEqual({ sessions: [], cursorUpdates: {} });
  });

  it("normalizes agent types, skips unknown/null session ids, and supports orphan tasks", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createMarsAgentConfigRoots(testHome);
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

    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });

    expect(marsRegistry.byAgentSessionId.claudeCode.has("cc-1")).toBe(true);
    expect(marsRegistry.byAgentSessionId.codex.has("cx-1")).toBe(true);
    expect(marsRegistry.byAgentSessionId.copilotCli.has("cp-1")).toBe(true);
    expect(marsRegistry.byAgentSessionId.claudeCode.has("x-1")).toBe(false);
    expect(marsRegistry.byAgentSessionId.claudeCode.get("cc-1")?.taskTitle).toBe("Task 1");
    expect(marsRegistry.byAgentSessionId.copilotCli.get("cp-1")?.taskTitle).toBeUndefined();
    expect(marsRegistry.claudeRoots).toHaveLength(1);
    expect(marsRegistry.codexRoots).toHaveLength(1);
    expect(marsRegistry.copilotRoots).toHaveLength(1);
  });

  it("merges stable and dev DB and keeps latest updated_at on duplicate agent_session_id", async () => {
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

    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    expect(marsRegistry.byAgentSessionId.claudeCode.get("dup")?.sessionName).toBe("new");
  });

  it("resets registry across runs", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createMarsDbFixture({
      homeDir: testHome,
      sessions: [{ idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agentType: "claude-code", agentSessionId: "first" }],
    });
    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    expect(marsRegistry.byAgentSessionId.claudeCode.has("first")).toBe(true);

    await fs.rm(path.join(testHome, "Library", "Application Support", "com.marsiwe.app", "marsiwe.db"), { force: true });
    await createMarsDbFixture({
      homeDir: testHome,
      sessions: [{ idHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agentType: "claude-code", agentSessionId: "second" }],
    });

    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    expect(marsRegistry.byAgentSessionId.claudeCode.has("first")).toBe(false);
    expect(marsRegistry.byAgentSessionId.claudeCode.has("second")).toBe(true);
  });
});
