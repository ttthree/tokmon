import { describe, expect, it } from "vitest";

import { mergeSession } from "../../src/core/data.js";
import type { Session } from "../../src/core/types.js";

describe("mergeSession", () => {
  it("keeps stronger token provenance over later weaker updates", () => {
    const strong = makeSession({
      tokenProvenance: "sdk-cc-jsonl",
      tokens: { input: 120, output: 30, cacheCreation: 10, cacheRead: 5 },
      modifiedAt: "2026-04-18T12:05:00.000Z",
    });
    const weak = makeSession({
      tokenProvenance: "none",
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      modifiedAt: "2026-04-18T12:10:00.000Z",
    });

    expect(mergeSession(strong, weak)).toMatchObject({
      tokenProvenance: "sdk-cc-jsonl",
      tokens: { input: 120, output: 30, cacheCreation: 10, cacheRead: 5 },
      modifiedAt: "2026-04-18T12:05:00.000Z",
    });
  });

  it("accepts stronger fallback provenance over weaker telemetry", () => {
    const telemetry = makeSession({
      tokenProvenance: "telemetry",
      tokens: { input: 60, output: 12, cacheCreation: 4, cacheRead: 10 },
      modifiedAt: "2026-04-18T12:05:00.000Z",
    });
    const shutdown = makeSession({
      tokenProvenance: "sdk-shutdown",
      tokens: { input: 200, output: 40, cacheCreation: 8, cacheRead: 20 },
      modifiedAt: "2026-04-18T12:06:00.000Z",
    });

    expect(mergeSession(telemetry, shutdown)).toMatchObject({
      tokenProvenance: "sdk-shutdown",
      tokens: { input: 200, output: 40, cacheCreation: 8, cacheRead: 20 },
      modifiedAt: "2026-04-18T12:06:00.000Z",
    });
  });

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
