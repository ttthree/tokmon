import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createClaudeCraftAgentsSubagentFixture, createClaudeFixture, createClaudeSubagentFixture, createTestHome } from "../../helpers/fixtures.js";
import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { claudeCodeParser } from "../../../src/parsers/claude-code.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("claude parser", () => {
  it("parses sessions-index and JSONL usage", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeFixture(testHome);
    const result = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].model).toBe("claude-sonnet-4-20250514");
    expect(result.sessions[0].toolBreakdown.Read).toBe(1);
    expect(result.sessions[0].tokens.cacheRead).toBe(10000);
  });

  it("maps subagent sessions to Eureka workingDirectory via parent index", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeSubagentFixture(testHome, {
      eurekaSessionId: "debug-session",
      parentSessionId: "parent-session-1",
      subagentId: "agent-sub-1",
      workingDirectory: `${testHome}/work/lumina-sandbox`,
      includeIndex: true,
    });

    const result = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].projectPath).toBe(`${testHome}/work/lumina-sandbox`);
    expect(result.sessions[0].project).toBe("lumina-sandbox");
  });

  it("maps subagent sessions to Eureka workingDirectory via encoded session id without index", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeSubagentFixture(testHome, {
      eurekaSessionId: "cool-ravine",
      parentSessionId: "parent-session-2",
      subagentId: "agent-sub-2",
      workingDirectory: `${testHome}/.craft-agent/workspaces/workspace-1/workdirectory`,
      includeIndex: false,
      encodedProjectDirName: "-Users-test--craft-agent-workspaces-workspace-1-sessions-cool-ravine",
    });

    const result = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].projectPath).toBe(`${testHome}/.craft-agent/workspaces/workspace-1/workdirectory`);
    expect(result.sessions[0].project).toBe("workdirectory");
  });

  it("resolves craft-agents subagent path from JSONL cwd, not encoded dir name", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeCraftAgentsSubagentFixture(testHome, {
      parentSessionId: "craft-parent-1",
      subagentId: "agent-a0e2e7f",
      cwd: `${testHome}/work/craft-agents`,
      encodedProjectDirName: "-Users-test-work-craft-agents",
      firstPrompt: "Explore the font system in this repo.",
    });

    const result = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].projectPath).toBe(`${testHome}/work/craft-agents`);
    expect(result.sessions[0].project).toBe("craft-agents");
    expect(result.sessions[0].firstPrompt).toBe("Explore the font system in this repo.");
  });

  it("normalizes craft-agents worktree subagent paths via JSONL cwd", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeCraftAgentsSubagentFixture(testHome, {
      parentSessionId: "craft-parent-wt",
      subagentId: "agent-af06c74",
      cwd: `${testHome}/work/craft-agents/.worktrees/ad1dc6d9-7d97-4694-8edb-7be3cd59ea62`,
      encodedProjectDirName: "-Users-test-work-craft-agents--worktrees-ad1dc6d9-7d97-4694-8edb-7be3cd59ea62",
    });

    const result = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].project).toBe("craft-agents");
  });
});
