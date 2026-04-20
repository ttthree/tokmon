import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../src/core/cursor.js";
import { getMachineDataPath } from "../../src/core/config.js";
import { loadMachineData } from "../../src/core/data.js";
import type { MachineData, Session } from "../../src/core/types.js";
import { createTestHome } from "../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("legacy data load e2e", () => {
  it("loads, migrates, persists, and reloads legacy eureka sessions idempotently", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const machineId = "legacy-machine";
    const machinePath = getMachineDataPath(machineId);
    await fs.mkdir(path.dirname(machinePath), { recursive: true });
    await fs.writeFile(machinePath, JSON.stringify(makeMachineData(machineId), null, 2), "utf8");

    const loaded = await loadMachineData(machineId);
    expect(Object.keys(loaded.sessions)).toHaveLength(1);
    expect(Object.keys(loaded.sessions)).toContain(`${machineId}:codex:legacy-session`);
    expect(loaded.sessions[`${machineId}:codex:legacy-session`]?.orchestrator).toEqual({ kind: "eureka" });

    const persisted = JSON.parse(await fs.readFile(machinePath, "utf8")) as MachineData;
    expect(Object.keys(persisted.sessions)).toHaveLength(1);
    expect(Object.keys(persisted.sessions)).toContain(`${machineId}:codex:legacy-session`);

    const reloaded = await loadMachineData(machineId);
    expect(reloaded.sessions).toEqual(loaded.sessions);
  });
});

function makeMachineData(machineId: string): MachineData {
  return {
    machineId,
    hostname: "legacy-host",
    os: "darwin-arm64",
    lastUpdatedAt: new Date().toISOString(),
    _cursor: createEmptyCursorState(),
    sessions: {
      [`${machineId}:eureka:legacy-session`]: makeSession({ id: "legacy-session", source: "eureka", engine: "Eureka + Codex" }),
    },
  };
}

function makeSession(overrides: Omit<Partial<Session>, "source"> & { id: string; source: Session["source"] | "eureka" }): Session {
  return {
    id: overrides.id,
    machineId: overrides.machineId ?? "legacy-machine",
    source: overrides.source as Session["source"],
    engine: overrides.engine ?? "Eureka + CC",
    projectPath: overrides.projectPath ?? "/tmp/project",
    project: overrides.project ?? "legacy-project",
    model: overrides.model ?? "model-a",
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
