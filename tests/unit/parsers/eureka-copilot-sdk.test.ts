import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { eurekaParser } from "../../../src/parsers/eureka.js";
import { createEurekaCopilotFixture, createTestHome } from "../../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("eureka copilot sdk parser", () => {
  it("prefers shutdown model metrics over telemetry", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCopilotFixture(testHome, {
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

    const result = await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    const session = result.sessions[0];

    expect(session.tokens).toEqual({ input: 270, output: 55, cacheCreation: 10, cacheRead: 30 });
    expect(session.modelUsage).toEqual({
      "gpt-4.1": { input: 180, output: 40, cacheCreation: 8, cacheRead: 20 },
      "gpt-4.1-mini": { input: 90, output: 15, cacheCreation: 2, cacheRead: 10 },
    });
    expect(session.source).toBe("copilot-cli");
    expect(session.orchestrator).toEqual({ kind: "eureka" });
    expect(session.tokenProvenance).toBe("sdk-shutdown");
    expect(session.model).toBe("gpt-4.1");
  });

  it("falls back to per-event accumulation when shutdown is absent", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCopilotFixture(testHome, {
      eventLines: [
        JSON.stringify({ type: "session.start", data: {} }),
        JSON.stringify({ type: "assistant.message", data: { usage: { inputTokens: 40, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 1 } } }),
        JSON.stringify({ type: "assistant.turn_end", data: { usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 } } }),
        JSON.stringify({ type: "tool.result", data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } } }),
        "",
      ],
    });

    const result = await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    const session = result.sessions[0];

    expect(session.tokens).toEqual({ input: 84, output: 22, cacheCreation: 2, cacheRead: 6 });
    expect(session.modelUsage).toEqual({
      "gpt-4.1": { input: 84, output: 22, cacheCreation: 2, cacheRead: 6 },
    });
    expect(session.tokenProvenance).toBe("sdk-events");
  });

  it("falls back to per-event accumulation when shutdown metrics are empty", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCopilotFixture(testHome, {
      eventLines: [
        JSON.stringify({ type: "assistant.turn_end", data: { usage: { inputTokens: 75, outputTokens: 18, cacheReadTokens: 15, cacheWriteTokens: 4 } } }),
        JSON.stringify({ type: "session.shutdown", data: { modelMetrics: { "unused-model": { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } } } }),
        "",
      ],
    });

    const result = await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    const session = result.sessions[0];

    expect(session.tokens).toEqual({ input: 60, output: 18, cacheCreation: 4, cacheRead: 15 });
    expect(session.tokenProvenance).toBe("sdk-events");
  });

  it("uses the last non-empty shutdown when a session resumes", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCopilotFixture(testHome, {
      eventLines: [
        JSON.stringify({ type: "session.shutdown", data: { modelMetrics: { "gpt-4.1": { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 1 } } } } }),
        JSON.stringify({ type: "session.resume", data: {} }),
        JSON.stringify({ type: "session.shutdown", data: { modelMetrics: { "gpt-4.1": { usage: { inputTokens: 220, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 6 } } } } }),
        "",
      ],
    });

    const result = await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    const session = result.sessions[0];

    expect(session.tokens).toEqual({ input: 200, output: 50, cacheCreation: 6, cacheRead: 20 });
    expect(session.tokenProvenance).toBe("sdk-shutdown");
  });
});
