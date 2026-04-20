import { describe, expect, it } from "vitest";

import { mergeSession } from "../../src/core/data.js";
import type { Session } from "../../src/core/types.js";

describe("mergeSession", () => {
  it("ignores placeholder epoch createdAt when merging with sane data", () => {
    const ghost = makeSession({
      createdAt: "1970-01-01T00:00:00.000Z",
      modifiedAt: "1970-01-01T00:00:00.000Z",
      tokenProvenance: "none",
    });
    const actual = makeSession({
      createdAt: "2026-04-18T12:00:00.000Z",
      modifiedAt: "2026-04-18T12:05:00.000Z",
      tokenProvenance: "sdk-cc-jsonl",
      tokens: { input: 120, output: 30, cacheCreation: 0, cacheRead: 0 },
    });

    expect(mergeSession(ghost, actual)).toMatchObject({
      createdAt: "2026-04-18T12:00:00.000Z",
      modifiedAt: "2026-04-18T12:05:00.000Z",
      tokenProvenance: "sdk-cc-jsonl",
    });
  });
});

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: overrides.id ?? "session-1",
    machineId: overrides.machineId ?? "machine-1",
    source: overrides.source ?? "claude-code",
    engine: overrides.engine ?? "Claude Code",
    projectPath: overrides.projectPath ?? "/tmp/project",
    project: overrides.project ?? "project",
    summary: overrides.summary,
    firstPrompt: overrides.firstPrompt,
    model: overrides.model ?? "model-a",
    createdAt: overrides.createdAt ?? "2026-04-18T12:00:00.000Z",
    modifiedAt: overrides.modifiedAt ?? "2026-04-18T12:05:00.000Z",
    durationSeconds: overrides.durationSeconds ?? 60,
    turns: overrides.turns ?? 1,
    messageCount: overrides.messageCount ?? 1,
    toolCallCount: overrides.toolCallCount ?? 0,
    tokens: overrides.tokens ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    cost: overrides.cost ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    toolBreakdown: overrides.toolBreakdown ?? {},
    modelUsage: overrides.modelUsage,
    tokenProvenance: overrides.tokenProvenance,
    orchestrator: overrides.orchestrator,
  };
}
