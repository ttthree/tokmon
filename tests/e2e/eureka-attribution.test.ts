import fs from "node:fs/promises";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { collectCommand } from "../../src/cli/commands/collect.js";
import { getMachineId } from "../../src/core/machine.js";
import { createApp } from "../../src/server/index.js";
import { createEurekaClaudeSdkFixture, createTestHome } from "../helpers/fixtures.js";

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

describe("eureka attribution e2e", () => {
  it("collects eureka sessions as underlying sources with eureka orchestrator metadata", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaClaudeSdkFixture(testHome, { sessionId: "eureka-e2e" });
    await collectCommand({ reset: true });

    const machineId = await getMachineId();
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });

    const all = await requestJson("/api/data?days=7");
    const eurekaOnly = await requestJson("/api/data?days=7&orchestrator=eureka");

    const session = all.body.sessions.find((item: { id: string }) => item.id === "eureka-e2e");
    expect(session).toMatchObject({
      machineId,
      source: "claude-code",
      orchestrator: { kind: "eureka" },
    });
    expect(eurekaOnly.body.sessions.map((item: { id: string }) => item.id)).toEqual(["eureka-e2e"]);
    expect(all.body.projects[0]?.sourceBreakdown.some((item: { label: string }) => item.label === "claude-code")).toBe(true);
  });
});

async function requestJson(route: string): Promise<{ status: number; body: any }> {
  const address = server?.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  return { status: response.status, body: await response.json() };
}
