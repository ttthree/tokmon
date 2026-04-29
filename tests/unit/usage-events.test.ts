import { describe, expect, it } from "vitest";

import { bucketUsageEventsByDay, filterUsageEventsByWindow, getSessionUsageEvents, sumUsageEvents, windowSessionUsage } from "../../src/core/usage-events.js";
import type { Session, UsageEvent } from "../../src/core/types.js";

describe("usage event helpers", () => {
  it("synthesizes a fallback event for legacy sessions", () => {
    const session = makeSession({ id: "legacy" });
    const events = getSessionUsageEvents(session);

    expect(events).toEqual([{
      at: session.createdAt,
      model: session.model,
      tokens: session.tokens,
      cost: session.cost,
      requestId: "legacy:legacy",
    }]);
  });

  it("filters with inclusive start and exclusive end", () => {
    const events = makeEvents();
    expect(filterUsageEventsByWindow(events, new Date("2026-04-10T12:00:00.000Z"), new Date("2026-04-11T00:00:00.000Z"))
      .map((event) => event.requestId)).toEqual(["b"]);
  });

  it("sums and buckets usage events", () => {
    const events = makeEvents();
    const sum = sumUsageEvents(events);
    expect(sum.tokens).toEqual({ input: 30, output: 6, cacheCreation: 3, cacheRead: 9 });
    expect(sum.cost.input).toBe(3);
    expect(sum.cost.output).toBe(6);
    expect(sum.cost.cacheCreation).toBe(1.5);
    expect(sum.cost.cacheRead).toBeCloseTo(0.3);
    expect(sum.cost.total).toBe(10.8);
    const buckets = bucketUsageEventsByDay(events);
    expect([...buckets.keys()]).toEqual(["2026-04-10", "2026-04-11"]);
    expect(buckets.get("2026-04-10")?.cost.total).toBe(7.2);
  });

  it("returns windowed session clones with recomputed totals and model usage", () => {
    const session = makeSession({ id: "cross-day", usageEvents: makeEvents() });
    const windowed = windowSessionUsage(session, new Date("2026-04-11T00:00:00.000Z"), new Date("2026-04-12T00:00:00.000Z"));

    expect(windowed?.usageEvents?.map((event) => event.requestId)).toEqual(["c"]);
    expect(windowed?.tokens).toEqual({ input: 10, output: 2, cacheCreation: 1, cacheRead: 3 });
    expect(windowed?.cost.total).toBe(3.6);
    expect(windowed?.modelUsage).toEqual({ "model-b": { input: 10, output: 2, cacheCreation: 1, cacheRead: 3 } });
    expect(windowSessionUsage(session, new Date("2026-04-12T00:00:00.000Z"), new Date("2026-04-13T00:00:00.000Z"))).toBeNull();
  });
});

function makeEvents(): UsageEvent[] {
  return [
    event("a", "2026-04-10T09:00:00.000Z", "model-a"),
    event("b", "2026-04-10T12:00:00.000Z", "model-a"),
    event("c", "2026-04-11T01:00:00.000Z", "model-b"),
  ];
}

function event(requestId: string, at: string, model: string): UsageEvent {
  return {
    at,
    model,
    requestId,
    tokens: { input: 10, output: 2, cacheCreation: 1, cacheRead: 3 },
    cost: { input: 1, output: 2, cacheCreation: 0.5, cacheRead: 0.1, total: 3.6 },
  };
}

function makeSession(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    id: overrides.id,
    machineId: "m1",
    source: "claude-code",
    projectPath: "/tmp/project",
    project: "project",
    model: "model-a",
    createdAt: "2026-04-10T00:00:00.000Z",
    modifiedAt: "2026-04-11T02:00:00.000Z",
    durationSeconds: 1,
    turns: 1,
    messageCount: 1,
    toolCallCount: 0,
    tokens: { input: 30, output: 6, cacheCreation: 3, cacheRead: 9 },
    cost: { input: 3, output: 6, cacheCreation: 1.5, cacheRead: 0.3, total: 10.8 },
    toolBreakdown: {},
    ...overrides,
  };
}
