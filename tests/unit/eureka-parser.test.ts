import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../src/core/cursor.js";
import { buildEurekaIndex } from "../../src/parsers/eureka-index.js";
import { createEurekaClaudeSdkFixture, createEurekaCodexFixture, createEurekaCopilotFixture, createTestHome } from "../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("buildEurekaIndex", () => {
  it("captures Claude header metadata and sdk mapping", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaClaudeSdkFixture(testHome, { sessionId: "eureka-claude", sdkSessionId: "claude-sdk-1" });

    const entry = await findEntry("eureka-claude");

    expect(entry).toMatchObject({
      eurekaSessionId: "eureka-claude",
      underlyingSource: "claude-code",
      sdkSessionId: "claude-sdk-1",
      headerModel: "claude-sonnet-4-20250514",
      telemetryProvenance: "none",
      workingDirectory: path.join(testHome, "work", "lumina"),
    });
  });

  it("infers codex source from session header and keeps fallback model", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaCodexFixture(testHome, { sessionId: "eureka-codex", sdkSessionId: "codex-sdk-1", headerModel: "gpt-5.4" });

    const entry = await findEntry("eureka-codex");

    expect(entry).toMatchObject({
      eurekaSessionId: "eureka-codex",
      underlyingSource: "codex",
      sdkSessionId: "codex-sdk-1",
      headerModel: "gpt-5.4",
      telemetryProvenance: "none",
    });
  });

  it("captures non-anthropic telemetry totals for orphan synthesis", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createEurekaCopilotFixture(testHome, {
      sessionId: "eureka-copilot",
      sdkSessionId: "copilot-sdk-1",
      telemetryLines: [
        JSON.stringify({
          kind: "llm_telemetry",
          timestamp: "2026-04-18T09:44:18.000Z",
          turnId: "turn-1",
          sessionType: "task",
          runtimeProvider: "copilot_sdk",
          provider: "github_copilot",
          workspaceRootPath: path.join(testHome, "work", "copilot-lab"),
          inputTokens: 60,
          outputTokens: 12,
          cacheReadTokens: 10,
          cacheCreationTokens: 4,
        }),
        "",
      ],
    });

    const entry = await findEntry("eureka-copilot");

    expect(entry).toMatchObject({
      underlyingSource: "copilot-cli",
      telemetryTokens: { input: 50, output: 12, cacheCreation: 4, cacheRead: 10 },
      telemetryProvenance: "telemetry",
      userTurns: 1,
    });
  });

  it("indexes sessions without sdkSessionId so Phase 4 can emit a none-provenance orphan", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createNoSdkEurekaFixture(testHome, "eureka-no-sdk");

    const entry = await findEntry("eureka-no-sdk");

    expect(entry.sdkSessionId).toBeUndefined();
    expect(entry.telemetryProvenance).toBe("telemetry");
    expect(entry.telemetryTokens).toEqual({ input: 90, output: 12, cacheCreation: 2, cacheRead: 10 });
  });

  it("dedupes duplicate Eureka session ids by preferring entries with live SDK artifacts", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaClaudeSdkFixture(testHome, {
      sessionId: "eureka-dup",
      sdkSessionId: "claude-sdk-live",
      workingDirectory: path.join(testHome, "work", "dup"),
    });

    const staleSessionDir = path.join(testHome, ".craft-agent", "workspaces", "workspace-2", "sessions", "eureka-dup");
    await fs.mkdir(staleSessionDir, { recursive: true });
    await fs.writeFile(
      path.join(staleSessionDir, "session.jsonl"),
      [
        JSON.stringify({
          id: "eureka-dup",
          createdAt: Date.parse("2026-04-18T08:00:00.000Z"),
          lastUsedAt: Date.parse("2026-04-18T08:05:00.000Z"),
          name: "Stale duplicate",
          engine: "claude",
          model: "claude-sonnet-4-20250514",
          runtimeProvider: "claude_agent_sdk",
          type: "task",
          workingDirectory: path.join(testHome, "work", "dup"),
          sdkSessionId: "claude-sdk-missing",
          sdkCwd: path.join(testHome, "work", "dup"),
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const index = await buildEurekaIndex({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    const matches = [...index.byCompositeKey.values()].filter((entry) => entry.eurekaSessionId === "eureka-dup");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      eurekaSessionId: "eureka-dup",
      sdkSessionId: "claude-sdk-live",
      workspaceId: "workspace-1",
    });
  });
});

async function findEntry(eurekaSessionId: string) {
  const index = await buildEurekaIndex({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
  const entry = [...index.byCompositeKey.values()].find((candidate) => candidate.eurekaSessionId === eurekaSessionId);
  expect(entry).toBeTruthy();
  return entry!;
}

async function createNoSdkEurekaFixture(testHome: string, sessionId: string): Promise<void> {
  const sessionDir = path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "session.jsonl"),
    [
      JSON.stringify({
        id: sessionId,
        createdAt: Date.parse("2026-04-18T12:00:00.000Z"),
        lastUsedAt: Date.parse("2026-04-18T12:05:00.000Z"),
        name: "No SDK session",
        engine: "claude",
        model: "gpt-4.1",
        runtimeProvider: "copilot_sdk",
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
        turnId: "turn-1",
        sessionType: "task",
        runtimeProvider: "copilot_sdk",
        provider: "github_copilot",
        workspaceRootPath: path.join(testHome, "work", "nosdk"),
        inputTokens: 100,
        outputTokens: 12,
        cacheReadTokens: 10,
        cacheCreationTokens: 2,
      }),
      "",
    ].join("\n"),
    "utf8",
  );
}
