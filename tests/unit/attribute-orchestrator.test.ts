import { describe, expect, it, vi } from "vitest";

import { attributeOrchestrator } from "../../src/core/attribute.js";
import type { Session } from "../../src/core/types.js";
import * as eurekaFallback from "../../src/parsers/eureka-fallback.js";
import { makeEurekaCompositeKey, type EurekaIndex, type EurekaIndexEntry } from "../../src/parsers/eureka-index.js";
import { createEmptyMarsRegistry } from "../../src/parsers/mars.js";

describe("attributeOrchestrator", () => {
  it("rekeys sessions on Eureka match and records matched composite keys", async () => {
    const entry = makeEurekaEntry({ eurekaSessionId: "eureka-1", sdkSessionId: "sdk-1", sdkCwd: "/tmp/project" });
    const result = await attributeOrchestrator([
      makeSession({ id: "sdk-1", projectPath: "/tmp/project" }),
    ], createEmptyMarsRegistry(), makeEurekaIndex([entry]));

    expect(result.attributed).toEqual([
      expect.objectContaining({ id: "eureka-1", engine: "Eureka + CC", orchestrator: { kind: "eureka" } }),
    ]);
    expect([...result.matchedEurekaCompositeKeys]).toEqual([entry.compositeKey]);
  });

  it("falls back to Mars tagging when Eureka does not match", async () => {
    const registry = createEmptyMarsRegistry();
    registry.byAgentSessionId.codex.set("mars-cx", {
      marsSessionId: "mars-1",
      agentSessionId: "mars-cx",
      agentType: "codex",
      taskId: "task-1",
      taskTitle: "Task One",
      isBackground: false,
      workspacePath: "/tmp/ws",
    });

    const result = await attributeOrchestrator([
      makeSession({ id: "mars-cx", source: "codex", engine: "Codex", projectPath: "/tmp/raw" }),
    ], registry, makeEurekaIndex([]));

    expect(result.attributed[0]).toMatchObject({
      engine: "Mars + Codex",
      projectPath: "/tmp/ws",
      orchestrator: { kind: "mars", taskId: "task-1", taskTitle: "Task One", marsSessionId: "mars-1" },
    });
  });

  it("leaves ambiguous bare sdkSessionId lookups unmatched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entryA = makeEurekaEntry({ eurekaSessionId: "eureka-a", sdkSessionId: "shared", sdkCwd: "/tmp/a" });
    const entryB = makeEurekaEntry({ eurekaSessionId: "eureka-b", sdkSessionId: "shared", sdkCwd: "/tmp/b" });

    const result = await attributeOrchestrator([
      makeSession({ id: "shared", projectPath: "/tmp/unknown" }),
    ], createEmptyMarsRegistry(), makeEurekaIndex([entryA, entryB]));

    expect(result.attributed[0].id).toBe("shared");
    expect(result.attributed[0].orchestrator).toBeUndefined();
    expect(result.matchedEurekaCompositeKeys.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ambiguous sdkSessionId lookup: shared"));
  });

  it("upgrades matched Eureka sessions when fallback provenance is stronger", async () => {
    const spy = vi.spyOn(eurekaFallback, "readEurekaFallbackTokens").mockResolvedValue({
      tokens: { input: 200, output: 40, cacheCreation: 8, cacheRead: 20 },
      models: ["gpt-4.1"],
      modelUsage: {
        "gpt-4.1": { input: 200, output: 40, cacheCreation: 8, cacheRead: 20 },
      },
      provenance: "sdk-shutdown",
    });

    const entry = makeEurekaEntry({
      eurekaSessionId: "eureka-copilot",
      underlyingSource: "copilot-cli",
      sdkSessionId: "copilot-sdk-1",
      sdkCwd: "/tmp/project",
      lastTimestamp: "2026-04-18T12:10:00.000Z",
      headerModel: "gpt-4.1",
    });

    const result = await attributeOrchestrator([
      makeSession({
        id: "copilot-sdk-1",
        source: "copilot-cli",
        engine: "Copilot CLI",
        projectPath: "/tmp/project",
        model: "gpt-4.1",
        tokenProvenance: "telemetry",
        tokens: { input: 60, output: 12, cacheCreation: 4, cacheRead: 10 },
      }),
    ], createEmptyMarsRegistry(), makeEurekaIndex([entry]));

    expect(result.attributed[0]).toMatchObject({
      id: "eureka-copilot",
      engine: "Eureka + Copilot",
      tokenProvenance: "sdk-shutdown",
      tokens: { input: 200, output: 40, cacheCreation: 8, cacheRead: 20 },
      model: "gpt-4.1",
      modifiedAt: "2026-04-18T12:10:00.000Z",
    });
    spy.mockRestore();
  });
});

function makeEurekaIndex(entries: EurekaIndexEntry[]): EurekaIndex {
  const byCompositeKey = new Map(entries.map((entry) => [entry.compositeKey, entry]));
  const bySdkSessionId = new Map<string, EurekaIndexEntry[]>();
  for (const entry of entries) {
    if (!entry.sdkSessionId) continue;
    bySdkSessionId.set(entry.sdkSessionId, [...(bySdkSessionId.get(entry.sdkSessionId) ?? []), entry]);
  }
  return {
    byCompositeKey,
    bySdkSessionId,
    lookup(sdkSessionId: string, sdkCwd?: string) {
      const direct = byCompositeKey.get(makeEurekaCompositeKey(sdkSessionId, sdkCwd, sdkSessionId));
      if (direct) return direct;
      const matches = bySdkSessionId.get(sdkSessionId) ?? [];
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) console.warn(`[eureka] ambiguous sdkSessionId lookup: ${sdkSessionId}`);
      return undefined;
    },
  };
}

function makeEurekaEntry(overrides: Partial<EurekaIndexEntry> & Pick<EurekaIndexEntry, "eurekaSessionId">): EurekaIndexEntry {
  const sdkSessionId = overrides.sdkSessionId ?? "sdk-default";
  const sdkCwd = overrides.sdkCwd ?? "/tmp/project";
  return {
    compositeKey: overrides.compositeKey ?? makeEurekaCompositeKey(sdkSessionId, sdkCwd, overrides.eurekaSessionId),
    workspaceId: overrides.workspaceId ?? "workspace-1",
    underlyingSource: overrides.underlyingSource ?? "claude-code",
    sdkSessionId: overrides.sdkSessionId ?? sdkSessionId,
    sdkCwd: overrides.sdkCwd ?? sdkCwd,
    eventTimestampsMs: overrides.eventTimestampsMs ?? [],
    sessionPath: overrides.sessionPath ?? "/tmp/eureka/session",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    id: overrides.id,
    machineId: overrides.machineId ?? "machine",
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
    tokens: overrides.tokens ?? { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
    cost: overrides.cost ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    toolBreakdown: overrides.toolBreakdown ?? {},
    modelUsage: overrides.modelUsage,
    tokenProvenance: overrides.tokenProvenance,
    orchestrator: overrides.orchestrator,
  };
}
