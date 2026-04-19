import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregateData,
  applyComparisonFilters,
  buildBreakdownItems,
  buildProjectSummaries,
  computeActiveDays,
  computeProjectSummary,
  getComparisonWindow,
} from "../../src/core/aggregate.js";
import type { Session } from "../../src/core/types.js";
import { createTestHome } from "../helpers/fixtures.js";

let testHome = "";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-12T12:00:00.000Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("aggregate helpers", () => {
  it("buildProjectSummaries aggregates sessions by project correctly", () => {
    const currentSessions = [
      makeSession({ id: "a-1", project: "alpha", costTotal: 12, turns: 3, createdAt: "2026-04-10T10:00:00.000Z" }),
      makeSession({ id: "a-2", project: "alpha", costTotal: 8, turns: 5, createdAt: "2026-04-11T10:00:00.000Z" }),
      makeSession({ id: "b-1", project: "beta", costTotal: 5, turns: 2, createdAt: "2026-04-11T12:00:00.000Z" }),
    ];

    const summaries = buildProjectSummaries(currentSessions, []);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      projectKey: "alpha",
      projectLabel: "alpha",
      totalCost: 20,
      sessionCount: 2,
      totalTurns: 8,
      avgCostPerSession: 10,
      avgTurnsPerSession: 4,
      activeDays: 2,
      totalTokens: 140,
      trend: undefined,
    });
    expect(summaries[0].tokenBreakdown).toEqual({ input: 40, output: 20, cacheCreation: 20, cacheRead: 60 });
  });

  it("sorts summaries by total cost desc, then session count desc, then project label asc", () => {
    const summaries = buildProjectSummaries([
      makeSession({ id: "c-1", project: "charlie", costTotal: 10 }),
      makeSession({ id: "b-1", project: "bravo", costTotal: 10 }),
      makeSession({ id: "b-2", project: "bravo", costTotal: 0 }),
      makeSession({ id: "a-1", project: "alpha", costTotal: 15 }),
    ], []);

    expect(summaries.map((summary) => summary.projectKey)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("computes active days from unique session dates", () => {
    const sessions = [
      makeSession({ id: "a", createdAt: "2026-04-10T00:00:00.000Z" }),
      makeSession({ id: "b", createdAt: "2026-04-10T12:00:00.000Z" }),
      makeSession({ id: "c", createdAt: "2026-04-11T00:00:00.000Z" }),
    ];

    expect(computeActiveDays(sessions)).toBe(2);
  });

  it("computes top source, top model, and top machine from deterministic breakdowns", () => {
    const summary = computeProjectSummary("alpha", [
      makeSession({ id: "1", project: "alpha", source: "codex", model: "gpt-4.1", machineId: "m2", costTotal: 7 }),
      makeSession({ id: "2", project: "alpha", source: "codex", model: "gpt-4.1", machineId: "m2", costTotal: 5 }),
      makeSession({ id: "3", project: "alpha", source: "claude-code", model: "claude-sonnet-4", machineId: "m1", costTotal: 2 }),
    ], []);

    expect(summary.topSource).toBe("codex");
    expect(summary.topModel).toBe("gpt-4.1");
    expect(summary.topMachine).toBe("m2");
  });

  it("builds source, model, and machine breakdowns with deterministic sorting", () => {
    const sessions = [
      makeSession({ id: "1", project: "alpha", source: "codex", model: "model-z", machineId: "m2", costTotal: 7 }),
      makeSession({ id: "2", project: "alpha", source: "claude-code", model: "model-a", machineId: "m1", costTotal: 7 }),
      makeSession({ id: "3", project: "alpha", source: "claude-code", model: "model-a", machineId: "m1", costTotal: 1 }),
    ];

    expect(buildBreakdownItems(sessions, "source")).toEqual([
      { key: "claude-code", label: "claude-code", cost: 8, sessions: 2 },
      { key: "codex", label: "codex", cost: 7, sessions: 1 },
    ]);
    expect(buildBreakdownItems(sessions, "model")).toEqual([
      { key: "model-a", label: "model-a", cost: 8, sessions: 2 },
      { key: "model-z", label: "model-z", cost: 7, sessions: 1 },
    ]);
    expect(buildBreakdownItems(sessions, "machine")).toEqual([
      { key: "m1", label: "m1", cost: 8, sessions: 2 },
      { key: "m2", label: "m2", cost: 7, sessions: 1 },
    ]);
  });

  it("computes trend against the previous equivalent period using rolling 7d boundaries", () => {
    const summary = computeProjectSummary("alpha", [
      makeSession({ id: "current", project: "alpha", costTotal: 30, createdAt: "2026-04-11T12:00:00.000Z" }),
    ], [
      makeSession({ id: "previous", project: "alpha", costTotal: 10, createdAt: "2026-04-03T12:00:00.000Z" }),
    ]);

    expect(summary.trend).toEqual({ previousCost: 10, delta: 20, deltaPct: 2 });
  });

  it("omits deltaPct when previous cost is zero", () => {
    const summary = computeProjectSummary("alpha", [
      makeSession({ id: "current", project: "alpha", costTotal: 12 }),
    ], [
      makeSession({ id: "previous", project: "alpha", costTotal: 0, createdAt: "2026-04-01T12:00:00.000Z" }),
    ]);

    expect(summary.trend).toEqual({ previousCost: 0, delta: 12, deltaPct: undefined });
  });

  it("omits trend for the all range", () => {
    const summaries = buildProjectSummaries([
      makeSession({ id: "alpha", project: "alpha", costTotal: 6 }),
    ], []);

    expect(summaries[0].trend).toBeUndefined();
  });

  it("returns an empty project summary list for empty sessions", () => {
    expect(buildProjectSummaries([], [])).toEqual([]);
  });

  it("supports mars-task breakdown grouping", () => {
    const sessions = [
      makeSession({ id: "m1", orchestrator: { kind: "mars", taskTitle: "Task One", marsSessionId: "x1" }, costTotal: 3 }),
      makeSession({ id: "m2", orchestrator: { kind: "mars", taskTitle: "Task One", marsSessionId: "x2" }, costTotal: 2 }),
      makeSession({ id: "m3", orchestrator: { kind: "mars", taskTitle: "Task Two", marsSessionId: "x3" }, costTotal: 5 }),
      makeSession({ id: "n1", costTotal: 1 }),
    ];

    expect(buildBreakdownItems(sessions, "mars-task")).toEqual([
      { key: "Task One", label: "Task One", cost: 5, sessions: 2 },
      { key: "Task Two", label: "Task Two", cost: 5, sessions: 1 },
      { key: "__untagged__", label: "__untagged__", cost: 1, sessions: 1 },
    ]);
  });

  it("uses documented inclusive and exclusive range boundaries", () => {
    const comparisonSessions = applyComparisonFilters([
      makeSession({ id: "prev-start", createdAt: "2026-03-29T12:00:00.000Z" }),
      makeSession({ id: "prev-end", createdAt: "2026-04-05T12:00:00.000Z" }),
      makeSession({ id: "before-prev-start", createdAt: "2026-03-29T11:59:59.000Z" }),
    ], { days: 7 }, Date.now());

    expect(comparisonSessions.map((session) => session.id)).toEqual(["prev-start"]);
  });
});

describe("aggregateData", () => {
  it("skips malformed remote machine files", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await fs.mkdir(path.join(testHome, ".tokmon", "remote"), { recursive: true });
    await fs.writeFile(path.join(testHome, ".tokmon", "remote", "broken.json"), "{not-json", "utf8");

    const data = await aggregateData();
    expect(data.machines).toHaveLength(1);
    expect(data.sessions).toEqual([]);
    expect(data.projects).toEqual([]);
  });

  it("applies orchestrator filter", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    const machineId = "local-machine";
    const machinePath = path.join(testHome, ".tokmon", "machines", `${machineId}.json`);
    await fs.mkdir(path.dirname(machinePath), { recursive: true });
    const sessions = {
      [`${machineId}:claude-code:mars`]: makeSession({ id: "mars", machineId, orchestrator: { kind: "mars", taskTitle: "Task", marsSessionId: "m" } }),
      [`${machineId}:claude-code:eureka`]: makeSession({ id: "eureka", source: "claude-code", machineId, orchestrator: { kind: "eureka" } }),
      [`${machineId}:codex:none`]: makeSession({ id: "none", source: "codex", machineId }),
    };
    await fs.writeFile(machinePath, JSON.stringify({ machineId, hostname: "h", os: "darwin-arm64", lastUpdatedAt: new Date().toISOString(), sessions, _cursor: { version: 1, updatedAt: new Date(0).toISOString(), files: {} } }), "utf8");
    await fs.writeFile(path.join(testHome, ".tokmon", ".machine-id"), `${machineId}\n`, "utf8");

    const marsOnly = await aggregateData({ orchestrator: "mars" });
    expect(marsOnly.sessions).toHaveLength(1);
    expect(marsOnly.sessions[0].id).toBe("mars");

    const noneOnly = await aggregateData({ orchestrator: "none" });
    expect(noneOnly.sessions).toHaveLength(1);
    expect(noneOnly.sessions[0].id).toBe("none");
  });
});

function makeSession(overrides: (Partial<Session> & Pick<Session, "id"> & { costTotal?: number })): Session {
  const costTotal = overrides.cost?.total ?? overrides.costTotal ?? 10;

  return {
    id: overrides.id,
    machineId: overrides.machineId ?? "m1",
    source: overrides.source ?? "claude-code",
    projectPath: overrides.projectPath ?? "/tmp/alpha",
    project: overrides.project ?? "alpha",
    summary: overrides.summary,
    firstPrompt: overrides.firstPrompt,
    model: overrides.model ?? "claude-sonnet-4",
    createdAt: overrides.createdAt ?? "2026-04-10T12:00:00.000Z",
    modifiedAt: overrides.modifiedAt ?? "2026-04-10T12:15:00.000Z",
    durationSeconds: overrides.durationSeconds ?? 900,
    turns: overrides.turns ?? 4,
    messageCount: overrides.messageCount ?? 2,
    toolCallCount: overrides.toolCallCount ?? 1,
    tokens: overrides.tokens ?? { input: 20, output: 10, cacheCreation: 10, cacheRead: 30 },
    cost: overrides.cost ?? {
      input: costTotal / 4,
      output: costTotal / 4,
      cacheCreation: costTotal / 4,
      cacheRead: costTotal / 4,
      total: costTotal,
    },
    toolBreakdown: overrides.toolBreakdown ?? { Read: 1 },
    orchestrator: overrides.orchestrator,
  };
}
