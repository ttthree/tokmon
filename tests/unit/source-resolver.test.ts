import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getClaudeDirectory } from "../../src/core/config.js";
import { encodeClaudeProjectPath, resolveSourcePath } from "../../src/core/source-resolver.js";
import type { Session } from "../../src/core/types.js";
import { createTestHome } from "../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("source resolver", () => {
  it("resolves a claude-code session to the expected jsonl path", async () => {
    const session = createSession({
      source: "claude-code",
      projectPath: "/Users/test/work/sample-project",
      id: "session-123",
    });

    expect(await resolveSourcePath(session)).toBe(path.join(getClaudeDirectory(), "projects", "-Users-test-work-sample-project", "session-123.jsonl"));
  });

  it("returns null for unsupported sources", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    expect(await resolveSourcePath(createSession({ source: "codex" }))).toBeNull();
    expect(await resolveSourcePath(createSession({ source: "copilot-cli" }))).toBeNull();
  });

  it("returns null when the project path is empty", async () => {
    expect(await resolveSourcePath(createSession({ source: "claude-code", projectPath: "" }))).toBeNull();
  });
});

describe("encodeClaudeProjectPath", () => {
  // Claude Code's on-disk project directory replaces every '/', '\\', ':' AND
  // '.' with '-'. Forgetting '.' was the cause of a regression where Eureka
  // sessions whose sdkCwd contained dotted segments (e.g. ".craft-agent") had
  // their CC jsonl path mis-encoded, causing token totals to silently drop to
  // zero on the next incremental collect.
  it("replaces dots so dotted segments match the on-disk encoding", () => {
    expect(encodeClaudeProjectPath("/Users/jietong/.craft-agent/workspaces/abc/workdirectory"))
      .toBe("-Users-jietong--craft-agent-workspaces-abc-workdirectory");
  });

  it("encodes plain POSIX paths", () => {
    expect(encodeClaudeProjectPath("/Users/test/work/sample-project"))
      .toBe("-Users-test-work-sample-project");
  });

  it("encodes Windows drive-letter paths", () => {
    expect(encodeClaudeProjectPath("C:\\Users\\test\\work\\sample"))
      .toBe("C--Users-test-work-sample");
  });

  it("encodes Windows paths whose segments contain dots", () => {
    expect(encodeClaudeProjectPath("C:\\Users\\test\\.craft-agent\\workdirectory"))
      .toBe("C--Users-test--craft-agent-workdirectory");
  });

  it("returns null for empty input", () => {
    expect(encodeClaudeProjectPath("")).toBeNull();
    expect(encodeClaudeProjectPath("   ")).toBeNull();
  });
});

function createSession(overrides: Partial<Session>): Session {
  return {
    id: "session-id",
    machineId: "machine-1",
    source: "claude-code",
    projectPath: "/tmp/project",
    project: "project",
    model: "claude-sonnet-4",
    createdAt: "2026-04-12T00:00:00.000Z",
    modifiedAt: "2026-04-12T00:05:00.000Z",
    durationSeconds: 300,
    turns: 1,
    messageCount: 2,
    toolCallCount: 1,
    tokens: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
    cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    toolBreakdown: {},
    ...overrides,
  };
}
