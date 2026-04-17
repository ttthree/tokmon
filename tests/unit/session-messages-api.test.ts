import fs from "node:fs/promises";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { collectCommand } from "../../src/cli/commands/collect.js";
import { getMachineId } from "../../src/core/machine.js";
import { createApp } from "../../src/server/index.js";
import { createClaudeFixture, createCodexFixture, createTestHome } from "../helpers/fixtures.js";

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

describe("session messages api", () => {
  it("returns parsed messages for a supported Claude session", async () => {
    const machineId = await setupCollectedHome(async (home) => {
      await createClaudeFixture(home, { sessionId: "rich-session", transcript: "rich" });
    });

    const response = await requestJson(`/api/session/${machineId}/claude-code/rich-session/messages`);

    expect(response.status).toBe(200);
    expect(response.body.supported).toBe(true);
    expect(response.body.messages).toHaveLength(3);
  });

  it("returns parsed messages for a codex session with a rollout", async () => {
    const machineId = await setupCollectedHome(async (home) => {
      await createCodexFixture(home, { includeRollout: true });
    });

    const response = await requestJson(`/api/session/${machineId}/codex/codex-session-1/messages`);

    expect(response.status).toBe(200);
    expect(response.body.supported).toBe(true);
    expect(response.body.sessionId).toBe("codex-session-1");
    expect(response.body.source).toBe("codex");
    expect(response.body.messages.length).toBeGreaterThan(0);
  });

  it("returns an error payload when the source file is missing", async () => {
    const machineId = await setupCollectedHome(async (home) => {
      await createClaudeFixture(home, { sessionId: "missing-session", transcript: "rich" });
    });

    const sourceFile = await findSessionFile("missing-session");
    await fs.rm(sourceFile, { force: true });

    const response = await requestJson(`/api/session/${machineId}/claude-code/missing-session/messages`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ supported: true, messages: [], error: "Source file no longer available" });
  });

  it("returns 404 when the session does not exist", async () => {
    await setupCollectedHome(async (home) => {
      await createClaudeFixture(home, { sessionId: "present-session" });
    });

    const response = await requestJson(`/api/session/machine-1/claude-code/missing/messages`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Session not found" });
  });

  it("returns partial messages with an error for malformed JSONL", async () => {
    const machineId = await setupCollectedHome(async (home) => {
      await createClaudeFixture(home, { sessionId: "broken-session", transcript: "malformed" });
    });

    const response = await requestJson(`/api/session/${machineId}/claude-code/broken-session/messages`);

    expect(response.status).toBe(200);
    expect(response.body.supported).toBe(true);
    expect(response.body.error).toBe("Some messages could not be parsed");
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

async function findSessionFile(sessionId: string): Promise<string> {
  const root = `${testHome}/.claude/projects`;
  const projectDirs = await fs.readdir(root);
  for (const projectDir of projectDirs) {
    const candidate = `${root}/${projectDir}/${sessionId}.jsonl`;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`Unable to locate source file for ${sessionId}`);
}
