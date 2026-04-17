import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { claudeCodeParser } from "../../../src/parsers/claude-code.js";
import { marsParser } from "../../../src/parsers/mars.js";
import { createTestHome } from "../../helpers/fixtures.js";
import { createMarsAgentConfigRoots, createMarsDbFixture } from "../../helpers/mars-fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("mars + claude integration", () => {
  it("tags matching Mars claude sessions", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const roots = await createMarsAgentConfigRoots(testHome);
    const workspacePath = path.join(testHome, "work", "mars-ws");
    await createMarsDbFixture({
      homeDir: testHome,
      workspaces: [{ idHex: "11111111111111111111111111111111", name: "ws", path: workspacePath }],
      tasks: [{ idHex: "22222222222222222222222222222222", workspaceIdHex: "11111111111111111111111111111111", title: "Task A" }],
      sessions: [{ idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "claude-code", agentSessionId: "mars-cc-1", name: "coder" }],
    });

    const projectDir = path.join(roots.claude, "projects", "-tmp-mars");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "mars-cc-1.jsonl"), [
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } }),
      "",
    ].join("\n"), "utf8");

    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    const result = await claudeCodeParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    const session = result.sessions.find((s) => s.id === "mars-cc-1");

    expect(session).toBeDefined();
    expect(session?.engine).toBe("Mars + CC");
    expect(session?.orchestrator?.kind).toBe("mars");
    expect(session?.orchestrator?.taskTitle).toBe("Task A");
    expect(session?.projectPath).toBe(workspacePath);
    expect(session?.tokens).toEqual({ input: 10, output: 5, cacheCreation: 1, cacheRead: 2 });
  });

  it("keeps unmatched sessions untagged", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const roots = await createMarsAgentConfigRoots(testHome);
    await createMarsDbFixture({
      homeDir: testHome,
      sessions: [{ idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agentType: "claude-code", agentSessionId: "different-id" }],
    });
    const projectDir = path.join(roots.claude, "projects", "-tmp-mars");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "raw-session.jsonl"), JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4", usage: { input_tokens: 3, output_tokens: 1 } } }) + "\n", "utf8");

    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    const result = await claudeCodeParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    const session = result.sessions.find((s) => s.id === "raw-session");

    expect(session?.orchestrator).toBeUndefined();
    expect(session?.engine).toBe("Claude Code");
  });
});
