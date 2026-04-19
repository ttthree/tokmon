import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ingestEurekaOrphans } from "../../../src/core/attribute.js";
import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { buildEurekaIndex } from "../../../src/parsers/eureka-index.js";
import { createEurekaCopilotFixture, createTestHome } from "../../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("eureka copilot orphan fallback", () => {
  it("prefers shutdown model metrics over per-event telemetry", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCopilotFixture(testHome, {
      sessionId: "eureka-shutdown",
      eventLines: [
        JSON.stringify({ type: "session.start", data: {} }),
        JSON.stringify({ type: "assistant.turn_end", data: { usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 } } }),
        JSON.stringify({
          type: "session.shutdown",
          data: {
            modelMetrics: {
              "gpt-4.1": { usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 8 } },
              "gpt-4.1-mini": { usage: { inputTokens: 100, outputTokens: 15, cacheReadTokens: 10, cacheWriteTokens: 2 } },
            },
          },
        }),
        "",
      ],
    });

    const session = await ingestSingle("eureka-shutdown");

    expect(session.tokens).toEqual({ input: 270, output: 55, cacheCreation: 10, cacheRead: 30 });
    expect(session.modelUsage).toEqual({
      "gpt-4.1": { input: 180, output: 40, cacheCreation: 8, cacheRead: 20 },
      "gpt-4.1-mini": { input: 90, output: 15, cacheCreation: 2, cacheRead: 10 },
    });
    expect(session.tokenProvenance).toBe("sdk-shutdown");
    expect(session.model).toBe("gpt-4.1");
  });

  it("falls back to per-event accumulation when shutdown metrics are absent", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCopilotFixture(testHome, {
      sessionId: "eureka-events",
      eventLines: [
        JSON.stringify({ type: "assistant.message", data: { usage: { inputTokens: 40, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 1 } } }),
        JSON.stringify({ type: "assistant.turn_end", data: { usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 } } }),
        JSON.stringify({ type: "tool.result", data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } } }),
        "",
      ],
    });

    const session = await ingestSingle("eureka-events");

    expect(session.tokens).toEqual({ input: 84, output: 22, cacheCreation: 2, cacheRead: 6 });
    expect(session.modelUsage).toEqual({
      "gpt-4.1": { input: 84, output: 22, cacheCreation: 2, cacheRead: 6 },
    });
    expect(session.tokenProvenance).toBe("sdk-events");
  });
});

async function ingestSingle(sessionId: string) {
  const index = await buildEurekaIndex({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
  const sessions = await ingestEurekaOrphans(index, new Set(), "machine-1");
  const session = sessions.find((candidate) => candidate.id === sessionId);
  expect(session).toBeTruthy();
  return session!;
}
