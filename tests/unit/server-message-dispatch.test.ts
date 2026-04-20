import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectCommand } from "../../src/cli/commands/collect.js";
import { getMachineId } from "../../src/core/machine.js";
import { encodeClaudeProjectPath } from "../../src/core/source-resolver.js";
import { createApp } from "../../src/server/index.js";
import { createClaudeFixture, createEurekaClaudeSdkFixture, createTestHome } from "../helpers/fixtures.js";
import { createMarsAgentConfigRoots, createMarsDbFixture } from "../helpers/mars-fixtures.js";

let testHome = "";
let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = null;
  }
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("server message dispatch", () => {
  it("routes migrated eureka sessions to the eureka message parser", async () => {
    const machineId = await setupCollectedHome(async (home) => {
      await createEurekaClaudeSdkFixture(home, { sessionId: "eureka-replay" });
      await fs.writeFile(
        path.join(home, ".craft-agent", "workspaces", "workspace-1", "sessions", "eureka-replay", "session.jsonl"),
        [
          JSON.stringify({ id: "eureka-replay", createdAt: Date.parse("2026-04-18T09:00:00.000Z"), lastUsedAt: Date.parse("2026-04-18T09:05:00.000Z"), runtimeProvider: "claude_agent_sdk", engine: "claude", sdkSessionId: "claude-sdk-session-1", sdkCwd: path.join(home, "work", "lumina") }),
          JSON.stringify({ type: "user", content: "Explain the bug", timestamp: Date.parse("2026-04-18T09:00:01.000Z") }),
          JSON.stringify({ type: "assistant", content: "Here is the issue", timestamp: Date.parse("2026-04-18T09:00:02.000Z") }),
          "",
        ].join("\n"),
        "utf8",
      );
    });

    const response = await requestJson(`/api/session/${machineId}/claude-code/eureka-replay/messages`);
    expect(response.status).toBe(200);
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[0].role).toBe("user");
  });

  it("routes mars claude sessions to the claude message parser", async () => {
    const machineId = await setupCollectedHome(async (home) => {
      await createMarsAgentConfigRoots(home);
      const workspacePath = path.join(home, "work", "mars-replay");
      await createMarsDbFixture({
        homeDir: home,
        workspaces: [{ idHex: "11111111111111111111111111111111", name: "ws", path: workspacePath }],
        tasks: [{ idHex: "22222222222222222222222222222222", workspaceIdHex: "11111111111111111111111111111111", title: "Task A" }],
        sessions: [{ idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "claude-code", agentSessionId: "mars-replay", name: "coder" }],
      });
      const replayDir = path.join(home, ".claude", "projects", encodeClaudeProjectPath(workspacePath) ?? "project");
      await fs.mkdir(replayDir, { recursive: true });
      const transcript = [
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Inspect the task" }] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "Done" }] } }),
        "",
      ].join("\n");
      await fs.writeFile(path.join(replayDir, "mars-replay.jsonl"), transcript, "utf8");
    });

    const response = await requestJson(`/api/session/${machineId}/claude-code/mars-replay/messages`);
    expect(response.status).toBe(200);
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[1].role).toBe("assistant");
  });

  it("routes direct claude sessions to the claude message parser", async () => {
    const machineId = await setupCollectedHome(async (home) => {
      await createClaudeFixture(home, { sessionId: "direct-replay", transcript: "rich" });
    });

    const response = await requestJson(`/api/session/${machineId}/claude-code/direct-replay/messages`);
    expect(response.status).toBe(200);
    expect(response.body.messages.length).toBeGreaterThan(0);
  });
});

async function setupCollectedHome(seed: (home: string) => Promise<void>): Promise<string> {
  testHome = await createTestHome();
  process.env.TOKMON_HOME = testHome;
  await seed(testHome);
  await collectCommand({ reset: true });
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  return getMachineId();
}

async function requestJson(route: string): Promise<{ status: number; body: any }> {
  const address = server?.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  return { status: response.status, body: await response.json() };
}
