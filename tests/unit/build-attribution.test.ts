import { describe, expect, it } from "vitest";

import { buildAttribution } from "../corpus/helpers/build-attribution.js";
import type { Session } from "../../src/core/types.js";

describe("buildAttribution", () => {
  it("builds attribution summary, linkage, and mars trees", () => {
    const result = buildAttribution([
      makeSession({ id: "plain-cc", source: "claude-code", engine: "Claude Code" }),
      makeSession({ id: "eureka-1", source: "claude-code", engine: "Eureka + CC", orchestrator: { kind: "eureka" }, tokens: { input: 10, output: 4, cacheCreation: 0, cacheRead: 2 } }),
      makeSession({ id: "eureka-2", source: "claude-code", engine: "Eureka + CC", orchestrator: { kind: "eureka" }, tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } }),
      makeSession({ id: "mars-1", source: "claude-code", engine: "Mars + CC", costTotal: 3, orchestrator: { kind: "mars", taskId: "task-1", taskTitle: "Task One", marsSessionId: "m1" } }),
      makeSession({ id: "mars-2", source: "codex", engine: "Mars + Codex", costTotal: 2, orchestrator: { kind: "mars", taskId: "task-1", taskTitle: "Task One", marsSessionId: "m2" } }),
    ]);

    expect(result.summary).toEqual({
      totalSessions: 5,
      perSource: { "claude-code": 4, codex: 1 },
      perEngine: { "Claude Code": 1, "Eureka + CC": 2, "Mars + CC": 1, "Mars + Codex": 1 },
      marsSessionCount: 2,
    });
    expect(result.eurekaLinkage).toEqual([
      { eurekaSessionId: "eureka-1", engine: "Eureka + CC", tokens: { input: 10, output: 4, cacheCreation: 0, cacheRead: 2 }, resolved: true },
      { eurekaSessionId: "eureka-2", engine: "Eureka + CC", tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }, resolved: false },
    ]);
    expect(result.marsTrees).toEqual([
      { taskId: "task-1", taskTitle: "Task One", sessionIds: ["mars-1", "mars-2"], totalCost: 5, totalTokens: 200 },
    ]);
  });

  it("surfaces duplicate session keys", () => {
    const result = buildAttribution([
      makeSession({ id: "dup", source: "claude-code", engine: "Claude Code" }),
      makeSession({ id: "dup", source: "claude-code", engine: "Eureka + CC", orchestrator: { kind: "eureka" } }),
    ]);

    expect(result.doubleCounting.duplicateSessionKeys).toEqual(["claude-code:dup"]);
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
