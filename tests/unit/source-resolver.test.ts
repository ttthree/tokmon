import path from "node:path";

import { describe, expect, it } from "vitest";

import { getClaudeDirectory } from "../../src/core/config.js";
import { resolveSourcePath } from "../../src/core/source-resolver.js";
import type { Session } from "../../src/core/types.js";

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
    expect(await resolveSourcePath(createSession({ source: "codex" }))).toBeNull();
    expect(await resolveSourcePath(createSession({ source: "copilot-cli" }))).toBeNull();
  });

  it("returns null when the project path is empty", async () => {
    expect(await resolveSourcePath(createSession({ source: "claude-code", projectPath: "" }))).toBeNull();
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
