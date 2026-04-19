import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { claudeCodeParser } from "../../../src/parsers/claude-code.js";
import { codexParser } from "../../../src/parsers/codex.js";
import { copilotCliParser } from "../../../src/parsers/copilot-cli.js";
import { eurekaParser } from "../../../src/parsers/eureka.js";
import {
  createClaudeFixture,
  createCodexFixture,
  createCopilotFixture,
  createEurekaClaudeSdkFixture,
  createEurekaCodexFixture,
  createEurekaCopilotFixture,
  createTestHome,
} from "../../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("token provenance matrix", () => {
  it("marks independent claude sessions as sdk-cc-jsonl", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createClaudeFixture(testHome);
    const session = (await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("sdk-cc-jsonl");
  });

  it("marks independent codex sessions as sdk-codex-rollout", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createCodexFixture(testHome, { includeRollout: true });
    const session = (await codexParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("sdk-codex-rollout");
  });

  it("marks copilot cli sessions as telemetry", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createCopilotFixture(testHome);
    const session = (await copilotCliParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("telemetry");
  });

  it("marks eureka claude sdk sessions as sdk-cc-jsonl when sdk files are reachable", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaClaudeSdkFixture(testHome);
    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("sdk-cc-jsonl");
  });

  it("marks eureka claude sdk sessions as telemetry-incomplete when sdk files are missing", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaClaudeSdkFixture(testHome, { includeSdkFile: false });
    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("telemetry-incomplete");
  });

  it("marks eureka copilot sdk sessions with shutdown metrics as sdk-shutdown", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaCopilotFixture(testHome);
    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("sdk-shutdown");
  });

  it("marks eureka copilot sdk sessions without shutdown metrics as sdk-events", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaCopilotFixture(testHome, {
      eventLines: [
        JSON.stringify({ type: "assistant.turn_end", data: { usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 } } }),
        "",
      ],
    });
    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("sdk-events");
  });

  it("marks eureka copilot sdk sessions without sdk files as telemetry-incomplete", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaCopilotFixture(testHome, { includeSdkFile: false });
    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("telemetry-incomplete");
  });

  it("marks eureka codex sdk sessions as sdk-codex-rollout", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaCodexFixture(testHome);
    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("sdk-codex-rollout");
  });

  it("marks eureka sessions without sdkSessionId as none and keeps tokens at zero", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const sessionDir = path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", "260418-no-sdk");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          id: "260418-no-sdk",
          createdAt: Date.parse("2026-04-18T12:00:00.000Z"),
          lastUsedAt: Date.parse("2026-04-18T12:05:00.000Z"),
          name: "No SDK session",
          engine: "claude",
          runtimeProvider: "claude_agent_sdk",
          type: "task",
          workingDirectory: path.join(testHome, "work", "nosdk"),
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionDir, "llm-telemetry.jsonl"),
      [
        JSON.stringify({
          kind: "llm_telemetry",
          timestamp: "2026-04-18T12:00:01.000Z",
          taskId: "260418-no-sdk",
          turnId: "turn-1",
          callId: "call-1",
          sessionType: "task",
          runtimeProvider: "claude_agent_sdk",
          provider: "github_copilot",
          model: "gpt-4.1",
          status: "ok",
          inputTokens: 100,
          outputTokens: 12,
          cacheReadTokens: 10,
          cacheCreationTokens: 2,
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.tokenProvenance).toBe("none");
    expect(session.tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
  });
});
