import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../src/core/cursor.js";
import { createApp } from "../../src/server/index.js";
import type { MachineData, Session } from "../../src/core/types.js";
import { createTestHome } from "../helpers/fixtures.js";

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

describe("server legacy query shim", () => {
  it("maps source=eureka to orchestrator=eureka", async () => {
    await setupServer();

    const legacy = await requestJson("/api/data?source=eureka");
    const explicit = await requestJson("/api/data?orchestrator=eureka");

    expect(legacy.body.sessions.map((session: Session) => session.id)).toEqual(["eureka-session"]);
    expect(legacy.body.sessions).toEqual(explicit.body.sessions);
  });

  it("maps source=mars to orchestrator=mars", async () => {
    await setupServer();

    const legacy = await requestJson("/api/data?source=mars");
    const explicit = await requestJson("/api/data?orchestrator=mars");

    expect(legacy.body.sessions.map((session: Session) => session.id)).toEqual(["mars-session"]);
    expect(legacy.body.sessions).toEqual(explicit.body.sessions);
  });

  it("prefers explicit orchestrator over legacy source shim when both are present", async () => {
    await setupServer();

    const response = await requestJson("/api/data?source=eureka&orchestrator=mars");

    expect(response.body.sessions.map((session: Session) => session.id)).toEqual(["mars-session"]);
  });

  it("serves legacy eureka message URLs after source migration", async () => {
    await setupServer();

    const response = await requestJson("/api/session/machine-1/eureka/eureka-session/messages");

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe("eureka-session");
    expect(response.body.source).toBe("claude-code");
    expect(response.body.messages).toHaveLength(2);
  });
});

async function setupServer(): Promise<void> {
  testHome = await createTestHome();
  process.env.TOKMON_HOME = testHome;

  const machineId = "machine-1";
  const tokmonDir = path.join(testHome, ".tokmon");
  await fs.mkdir(path.join(tokmonDir, "machines"), { recursive: true });
  await fs.writeFile(path.join(tokmonDir, ".machine-id"), `${machineId}\n`, "utf8");
  await fs.writeFile(path.join(tokmonDir, "machines", `${machineId}.json`), JSON.stringify(makeMachineData(machineId), null, 2), "utf8");
  const eurekaDir = path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", "eureka-session");
  await fs.mkdir(eurekaDir, { recursive: true });
  await fs.writeFile(
    path.join(eurekaDir, "session.jsonl"),
    [
      JSON.stringify({ id: "eureka-session", createdAt: Date.parse("2026-04-18T12:00:00.000Z") }),
      JSON.stringify({ type: "user", content: "Legacy route prompt", timestamp: Date.parse("2026-04-18T12:00:01.000Z") }),
      JSON.stringify({ type: "assistant", content: "Legacy route reply", timestamp: Date.parse("2026-04-18T12:00:02.000Z") }),
      "",
    ].join("\n"),
    "utf8",
  );

  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
}

function makeMachineData(machineId: string): MachineData {
  return {
    machineId,
    hostname: "host",
    os: "darwin-arm64",
    lastUpdatedAt: new Date().toISOString(),
    _cursor: createEmptyCursorState(),
    sessions: {
      [`${machineId}:claude-code:eureka-session`]: makeSession({ id: "eureka-session", orchestrator: { kind: "eureka" } }),
      [`${machineId}:claude-code:mars-session`]: makeSession({ id: "mars-session", orchestrator: { kind: "mars" } }),
      [`${machineId}:claude-code:direct-session`]: makeSession({ id: "direct-session" }),
    },
  };
}

function makeSession(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    id: overrides.id,
    machineId: overrides.machineId ?? "machine-1",
    source: overrides.source ?? "claude-code",
    projectPath: overrides.projectPath ?? "/tmp/project",
    project: overrides.project ?? "alpha",
    model: overrides.model ?? "claude-sonnet-4",
    createdAt: overrides.createdAt ?? "2026-04-18T12:00:00.000Z",
    modifiedAt: overrides.modifiedAt ?? "2026-04-18T12:05:00.000Z",
    durationSeconds: overrides.durationSeconds ?? 300,
    turns: overrides.turns ?? 2,
    messageCount: overrides.messageCount ?? 2,
    toolCallCount: overrides.toolCallCount ?? 0,
    tokens: overrides.tokens ?? { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
    cost: overrides.cost ?? { input: 1, output: 1, cacheCreation: 0, cacheRead: 0, total: 2 },
    toolBreakdown: overrides.toolBreakdown ?? {},
    orchestrator: overrides.orchestrator,
  };
}

async function requestJson(route: string): Promise<{ status: number; body: any }> {
  const address = server?.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  return { status: response.status, body: await response.json() };
}
