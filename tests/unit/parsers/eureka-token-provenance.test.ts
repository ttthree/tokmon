import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ingestEurekaOrphans } from "../../../src/core/attribute.js";
import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { eurekaEngineLabel } from "../../../src/parsers/eureka-fallback.js";
import { buildEurekaIndex } from "../../../src/parsers/eureka-index.js";
import { createEurekaClaudeSdkFixture, createEurekaCodexFixture, createEurekaCopilotFixture, createEurekaPiFixture, createTestHome } from "../../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("Eureka token provenance helpers", () => {
  it("does not mislabel copilot runtime providers as PI", () => {
    expect(eurekaEngineLabel("copilot-cli", "copilot_sdk")).toBe("Eureka + Copilot");
    expect(eurekaEngineLabel("pi-agent", "pi_coding_agent")).toBe("Eureka + Pi");
  });
});

describe("ingestEurekaOrphans provenance matrix", () => {
  it("emits telemetry-backed orphan when sdk files are missing", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaCopilotFixture(testHome, { sessionId: "eureka-orphan", includeSdkFile: false });

    const session = await ingestSingle("eureka-orphan");

    expect(session.source).toBe("copilot-cli");
    expect(session.orchestrator).toEqual({ kind: "eureka" });
    expect(session.tokenProvenance).toBe("telemetry");
    expect(session.tokens).toEqual({ input: 50, output: 12, cacheCreation: 4, cacheRead: 10 });
  });

  it("emits none-provenance orphan when neither sdk nor telemetry totals exist", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaClaudeSdkFixture(testHome, { sessionId: "eureka-none", includeSdkFile: false });

    const session = await ingestSingle("eureka-none");

    expect(session.source).toBe("claude-code");
    expect(session.tokenProvenance).toBe("none");
    expect(session.tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
    expect(session.model).toBe("claude-sonnet-4-20250514");
  });


  it("uses PI coding agent JSONL tokens for PI runtime sessions", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaPiFixture(testHome, { sessionId: "eureka-pi", headerModel: "gpt-5.5" });
    await fs.writeFile(
      path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", "eureka-pi", ".pi", "2026-07-09T07-44-00-000Z_eureka-pi.jsonl"),
      [
        JSON.stringify({ type: "model_change", timestamp: "2026-07-09T07:44:00.000Z", modelId: "gpt-5.5" }),
        JSON.stringify({
          type: "message",
          id: "assistant-1-duplicate",
          timestamp: "2026-07-09T07:44:01.000Z",
          message: { role: "assistant", model: "gpt-5.5", responseId: "response-1", usage: { input: 6659, output: 211, cacheRead: 2560, cacheWrite: 0 } },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-2-duplicate",
          timestamp: "2026-07-09T07:44:02.000Z",
          message: { role: "assistant", model: "gpt-5.5", responseId: "response-2", usage: { input: 643, output: 343, cacheRead: 71168, cacheWrite: 0 } },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const session = await ingestSingle("eureka-pi");

    expect(session.source).toBe("pi-agent");
    expect(session.engine).toBe("Eureka + Pi");
    expect(session.tokenProvenance).toBe("sdk-pi-jsonl");
    expect(session.tokens).toEqual({ input: 7302, output: 554, cacheCreation: 0, cacheRead: 73728 });
    expect(session.model).toBe("gpt-5.5");
    expect(session.modelUsage).toEqual({
      "gpt-5.5": { input: 7302, output: 554, cacheCreation: 0, cacheRead: 73728 },
    });
    expect(session.usageEvents).toHaveLength(2);
  });

  it("uses PI JSONL when custom-model runtime disposal cleared sdkSessionId", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaPiFixture(testHome, {
      sessionId: "eureka-pi-custom",
      headerModel: "custom-model:endpoint:anthropic%2Fmessages:deepseek-v4-flash-anthropic",
      omitSdkSessionId: true,
      eventLines: [
        JSON.stringify({ type: "session", version: 3, id: "eureka-pi-custom", timestamp: "2026-08-05T05:58:58.905Z" }),
        JSON.stringify({ type: "model_change", timestamp: "2026-08-05T05:58:58.941Z", provider: "eureka-custom-endpoint", modelId: "deepseek-v4-flash-anthropic" }),
        JSON.stringify({
          type: "message",
          id: "assistant-custom",
          timestamp: "2026-08-05T05:59:02.346Z",
          message: {
            role: "assistant",
            provider: "eureka-custom-endpoint",
            model: "deepseek-v4-flash-anthropic",
            responseId: "response-custom",
            usage: { input: 9057, output: 169, cacheRead: 2944, cacheWrite: 0 },
          },
        }),
        "",
      ],
    });

    const session = await ingestSingle("eureka-pi-custom");

    expect(session.source).toBe("pi-agent");
    expect(session.tokenProvenance).toBe("sdk-pi-jsonl");
    expect(session.tokens).toEqual({ input: 9057, output: 169, cacheCreation: 0, cacheRead: 2944 });
    expect(session.model).toBe("deepseek-v4-flash-anthropic");
    expect(session.modelUsage).toEqual({
      "deepseek-v4-flash-anthropic": { input: 9057, output: 169, cacheCreation: 0, cacheRead: 2944 },
    });
  });

  it("uses embedded codex rollout tokens when Phase 1 cannot see the sdk file", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaCodexFixture(testHome, { sessionId: "eureka-codex" });

    const session = await ingestSingle("eureka-codex");

    expect(session.source).toBe("codex");
    expect(session.tokenProvenance).toBe("sdk-codex-rollout");
    expect(session.tokens).toEqual({ input: 1300, output: 90, cacheCreation: 0, cacheRead: 300 });
    expect(session.model).toBe("gpt-5.4");
    expect(session.usageEvents).toHaveLength(2);
    expect(session.usageEvents?.map((event) => event.at)).toEqual(["2026-04-12T01:25:23.000Z", "2026-04-12T01:30:02.000Z"]);
  });
});

async function ingestSingle(sessionId: string) {
  const index = await buildEurekaIndex({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
  const sessions = await ingestEurekaOrphans(index, new Set(), "machine-1");
  const session = sessions.find((candidate) => candidate.id === sessionId);
  expect(session).toBeTruthy();
  return session!;
}
