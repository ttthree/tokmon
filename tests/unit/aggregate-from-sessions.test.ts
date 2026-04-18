import { describe, expect, it } from "vitest";

import { aggregateFromSessions } from "../corpus/helpers/aggregate-from-sessions.js";
import type { Session } from "../../src/core/types.js";

describe("aggregateFromSessions", () => {
  it("builds the documented aggregate shape", () => {
    const result = aggregateFromSessions([
      makeSession({ id: "a", project: "alpha", model: "model-a", costTotal: 3, createdAt: "2026-04-18T10:00:00.000Z" }),
      makeSession({ id: "b", project: "beta", model: "model-b", source: "codex", costTotal: 5, createdAt: "2026-04-19T10:00:00.000Z", orchestrator: { kind: "mars", taskId: "task-1", taskTitle: "Task One", marsSessionId: "mars-1" } }),
      makeSession({ id: "c", project: "alpha", model: "model-a", costTotal: 2, createdAt: "2026-04-19T11:00:00.000Z" }),
    ]);

    expect(result.totals.sessions).toBe(3);
    expect(result.perSource.map((item) => item.key)).toEqual(["claude-code", "codex"]);
    expect(result.perModel.map((item) => item.key)).toEqual(["model-a", "model-b"]);
    expect(result.perMachine).toEqual([{ key: "machine", label: "machine", cost: 10, sessions: 3 }]);
    expect(result.perMarsTask).toEqual([
      { key: "__untagged__", label: "__untagged__", cost: 5, sessions: 2 },
      { key: "Task One", label: "Task One", cost: 5, sessions: 1 },
    ]);
    expect(result.perDay).toEqual([
      { date: "2026-04-18", cost: 3, sessions: 1, tokens: 100 },
      { date: "2026-04-19", cost: 7, sessions: 2, tokens: 200 },
    ]);
    expect(result.leaderboards).toEqual({ topProjects: ["alpha", "beta"], topModels: ["model-a", "model-b"] });
  });

  it("rounds only cost-bearing float fields", () => {
    const result = aggregateFromSessions([
      makeSession({
        id: "tiny",
        cost: {
          input: 1 / 3,
          output: 1 / 7,
          cacheCreation: 1 / 11,
          cacheRead: 1 / 13,
          total: 1 / 3 + 1 / 7 + 1 / 11 + 1 / 13,
        },
      }),
    ]);

    expect(result.totals.cost.total).toBe(Number(result.totals.cost.total.toFixed(12)));
    expect(result.totals.cacheHitRate).toBe(Number(result.totals.cacheHitRate.toFixed(12)));
    expect(result.totals.tokens.input).toBe(20);
    expect(result.totals.durationSeconds).toBe(900);
  });
});

function makeSession(overrides: Partial<Session> & Pick<Session, "id"> & { costTotal?: number }): Session {
  const costTotal = overrides.cost?.total ?? overrides.costTotal ?? 5;
  return {
    id: overrides.id,
    machineId: overrides.machineId ?? "machine",
    source: overrides.source ?? "claude-code",
    engine: overrides.engine ?? "Claude Code",
    projectPath: overrides.projectPath ?? "/tmp/project",
    project: overrides.project ?? "alpha",
    summary: overrides.summary,
    firstPrompt: overrides.firstPrompt,
    model: overrides.model ?? "model-a",
    createdAt: overrides.createdAt ?? "2026-04-18T12:00:00.000Z",
    modifiedAt: overrides.modifiedAt ?? "2026-04-18T12:15:00.000Z",
    durationSeconds: overrides.durationSeconds ?? 900,
    turns: overrides.turns ?? 4,
    messageCount: overrides.messageCount ?? 2,
    toolCallCount: overrides.toolCallCount ?? 1,
    tokens: overrides.tokens ?? { input: 20, output: 10, cacheCreation: 10, cacheRead: 60 },
    cost: overrides.cost ?? { input: costTotal / 4, output: costTotal / 4, cacheCreation: costTotal / 4, cacheRead: costTotal / 4, total: costTotal },
    toolBreakdown: overrides.toolBreakdown ?? { Read: 1 },
    modelUsage: overrides.modelUsage,
    orchestrator: overrides.orchestrator,
  };
}
