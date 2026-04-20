import { describe, expect, it } from "vitest";

import { sanitizeLoadedMachineData } from "../../src/core/data.js";
import { createEmptyCursorState } from "../../src/core/cursor.js";
import type { MachineData, Session } from "../../src/core/types.js";

describe("sanitizeLoadedMachineData", () => {
  it("drops legacy ghost sessions with epoch timestamps and no usage", () => {
    const machineId = "machine-1";
    const sanitized = sanitizeLoadedMachineData({
      machineId,
      hostname: "test-host",
      os: "darwin-arm64",
      lastUpdatedAt: new Date().toISOString(),
      _cursor: createEmptyCursorState(),
      sessions: {
        [`${machineId}:claude-code:ghost`]: makeSession({
          id: "ghost",
          createdAt: "1970-01-01T00:00:00.000Z",
          modifiedAt: "1970-01-01T00:00:00.000Z",
          tokenProvenance: "none",
          tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
          cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
        }),
        [`${machineId}:claude-code:real`]: makeSession({ id: "real" }),
      },
    });

    expect(Object.keys(sanitized.sessions)).toEqual([`${machineId}:claude-code:real`]);
  });
});

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    id: overrides.id,
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
