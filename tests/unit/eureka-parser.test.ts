import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../src/core/cursor.js";
import { claudeCodeParser } from "../../src/parsers/claude-code.js";
import { eurekaParser } from "../../src/parsers/eureka.js";
import {
  createEurekaClaudeSdkFixture,
  createEurekaCodexFixture,
  createEurekaCopilotFixture,
  createTestHome,
} from "../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("eureka parser source attribution", () => {
  it("sets source to claude-code for Claude-backed Eureka sessions", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaClaudeSdkFixture(testHome);

    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.source).toBe("claude-code");
    expect(session.orchestrator).toEqual({ kind: "eureka" });
  });

  it("sets source to codex for Codex-backed Eureka sessions", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCodexFixture(testHome);

    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.source).toBe("codex");
    expect(session.orchestrator).toEqual({ kind: "eureka" });
  });

  it("sets source to copilot-cli for Copilot-backed Eureka sessions", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCopilotFixture(testHome);

    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.source).toBe("copilot-cli");
    expect(session.orchestrator).toEqual({ kind: "eureka" });
  });

  it.each([
    { sessionId: "no-sdk-copilot", runtimeProvider: "copilot_sdk", engine: "claude", expected: "copilot-cli" },
    { sessionId: "no-sdk-codex", runtimeProvider: "codex_agent_sdk", engine: "codex", expected: "codex" },
    { sessionId: "no-sdk-claude", runtimeProvider: "claude_agent_sdk", engine: "claude", expected: "claude-code" },
  ] as const)("infers source from hints when sdkSessionId is missing: $expected", async ({ sessionId, runtimeProvider, engine, expected }) => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await writeNoSdkSession(testHome, sessionId, runtimeProvider, engine);

    const session = (await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() })).sessions[0];
    expect(session.source).toBe(expected);
    expect(session.orchestrator).toEqual({ kind: "eureka" });
    expect(session.tokenProvenance).toBe("none");
  });

  it("keeps Claude Code parser from double-counting claimed SDK sessions", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaClaudeSdkFixture(testHome, { sdkSessionId: "claimed-sdk-session" });
    await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });

    const ccResult = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(ccResult.sessions.some((session) => session.id === "claimed-sdk-session")).toBe(false);
  });

  it("re-parses legacy Eureka cursors that pre-date the claim mechanism", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaClaudeSdkFixture(testHome, { sessionId: "legacy-eureka-session", sdkSessionId: "legacy-sdk-session" });

    // Build a legacy cursor: matches inode/size/mtime exactly but lacks
    // claimedSdkSessionId/claimedSdkCwd/lastProvenance. Without the legacy-cursor
    // fix the cache hit short-circuits parsing and CC parser double-counts the SDK file.
    const eurekaSessionPath = path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", "legacy-eureka-session");
    const telemetryPath = path.join(eurekaSessionPath, "llm-telemetry.jsonl");
    const primaryStat = await fs.stat(telemetryPath);

    const cursorState = createEmptyCursorState();
    cursorState.files[telemetryPath] = {
      path: telemetryPath,
      inode: Number(primaryStat.ino),
      size: Number(primaryStat.size),
      mtimeMs: Number(primaryStat.mtimeMs),
      byteOffset: Number(primaryStat.size),
      processedAt: new Date().toISOString(),
      // Intentionally no claimedSdkSessionId / claimedSdkCwd / lastProvenance
    };

    const eurekaResult = await eurekaParser.parse({ machineId: "machine-1", existingCursor: cursorState });
    // Should re-parse, producing the session and a fresh cursor with claim info.
    expect(eurekaResult.sessions.some((s) => s.id === "legacy-eureka-session")).toBe(true);
    const newCursor = eurekaResult.cursorUpdates[telemetryPath];
    expect(newCursor?.claimedSdkSessionId).toBe("legacy-sdk-session");
    expect(newCursor?.lastProvenance).toBeDefined();

    // CC parser must skip the now-claimed SDK file.
    const ccResult = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(ccResult.sessions.some((s) => s.id === "legacy-sdk-session")).toBe(false);
  });
});

async function writeNoSdkSession(testHome: string, sessionId: string, runtimeProvider: string, engine: string): Promise<void> {
  const sessionDir = path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "session.jsonl"),
    [
      JSON.stringify({
        id: sessionId,
        createdAt: Date.parse("2026-04-18T12:00:00.000Z"),
        lastUsedAt: Date.parse("2026-04-18T12:05:00.000Z"),
        name: `No SDK ${sessionId}`,
        engine,
        runtimeProvider,
        type: "task",
        workingDirectory: path.join(testHome, "work", sessionId),
      }),
      "",
    ].join("\n"),
    "utf8",
  );
}
