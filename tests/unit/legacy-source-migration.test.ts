import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getMachineDataPath, loadMachineDataFromPath } from "../../src/core/config.js";
import { loadMachineData } from "../../src/core/data.js";
import { createEmptyCursorState } from "../../src/core/cursor.js";
import type { MachineData, Session, Source } from "../../src/core/types.js";
import { inferSourceFromEngine, normalizeLegacySources, pickFresher } from "../../src/core/data.js";
import { createTestHome } from "../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("legacy source migration", () => {
  it("normalizes legacy eureka entries on load and rewrites persisted keys", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const machineId = "machine-1";
    const machinePath = getMachineDataPath(machineId);
    await fs.mkdir(path.dirname(machinePath), { recursive: true });
    await fs.writeFile(machinePath, JSON.stringify(makeMachineData(machineId, {
      [`${machineId}:eureka:abc`]: makeSession({ id: "abc", source: "eureka", engine: "Eureka + CC" }),
    }), null, 2), "utf8");

    const loaded = await loadMachineData(machineId);
    expect(Object.keys(loaded.sessions)).toEqual([`${machineId}:claude-code:abc`]);
    expect(loaded.sessions[`${machineId}:claude-code:abc`]?.orchestrator).toEqual({ kind: "eureka" });

    const persisted = JSON.parse(await fs.readFile(machinePath, "utf8")) as MachineData;
    expect(Object.keys(persisted.sessions)).toEqual([`${machineId}:claude-code:abc`]);
  });

  it("infers underlying source from engine labels", () => {
    expect(inferSourceFromEngine("Eureka + CC")).toBe("claude-code");
    expect(inferSourceFromEngine("Eureka + Codex")).toBe("codex");
    expect(inferSourceFromEngine("Eureka + Copilot CLI")).toBe("copilot-cli");
    expect(inferSourceFromEngine("unknown")).toBe("claude-code");
  });

  it("is idempotent once data is already migrated", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const machineId = "machine-2";
    const machinePath = getMachineDataPath(machineId);
    await fs.mkdir(path.dirname(machinePath), { recursive: true });

    const migrated = normalizeLegacySources(makeMachineData(machineId, {
      [`${machineId}:eureka:def`]: makeSession({ id: "def", source: "eureka", engine: "Eureka + Codex" }),
    }));
    await fs.writeFile(machinePath, JSON.stringify(migrated, null, 2), "utf8");

    const reloaded = await loadMachineDataFromPath(machinePath);
    expect(reloaded.sessions).toEqual(migrated.sessions);
  });

  it("collapses collisions via pickFresher and leaves mars sessions untouched", () => {
    const machineId = "machine-3";
    const migrated = normalizeLegacySources(makeMachineData(machineId, {
      [`${machineId}:eureka:same`]: makeSession({ id: "same", source: "eureka", engine: "Eureka + CC", costTotal: 0, modifiedAt: "2026-04-18T09:00:00.000Z" }),
      [`${machineId}:claude-code:same`]: makeSession({ id: "same", source: "claude-code", costTotal: 10, modifiedAt: "2026-04-18T10:00:00.000Z" }),
      [`${machineId}:claude-code:mars`]: makeSession({ id: "mars", source: "claude-code", orchestrator: { kind: "mars" } }),
    }));

    expect(Object.keys(migrated.sessions).sort()).toEqual([
      `${machineId}:claude-code:mars`,
      `${machineId}:claude-code:same`,
    ]);
    expect(migrated.sessions[`${machineId}:claude-code:same`]?.cost.total).toBe(10);
    expect(migrated.sessions[`${machineId}:claude-code:mars`]?.orchestrator).toEqual({ kind: "mars" });
    expect(pickFresher(
      makeSession({ id: "a", source: "claude-code", costTotal: 0, modifiedAt: "2026-04-18T09:00:00.000Z" }),
      makeSession({ id: "a", source: "claude-code", costTotal: 1, modifiedAt: "2026-04-18T08:00:00.000Z" }),
    ).cost.total).toBe(1);
  });
});

function makeMachineData(machineId: string, sessions: Record<string, Session>): MachineData {
  return {
    machineId,
    hostname: "test-host",
    os: "darwin-arm64",
    lastUpdatedAt: new Date().toISOString(),
    sessions,
    _cursor: createEmptyCursorState(),
  };
}

function makeSession(overrides: Omit<Partial<Session>, "source"> & { id: string; source: Source | "eureka"; costTotal?: number }): Session {
  const costTotal = overrides.cost?.total ?? overrides.costTotal ?? 5;
  return {
    id: overrides.id,
    machineId: overrides.machineId ?? "machine",
    source: overrides.source as Session["source"],
    engine: overrides.engine ?? "Claude Code",
    projectPath: overrides.projectPath ?? "/tmp/project",
    project: overrides.project ?? "alpha",
    model: overrides.model ?? "model-a",
    createdAt: overrides.createdAt ?? "2026-04-18T08:00:00.000Z",
    modifiedAt: overrides.modifiedAt ?? "2026-04-18T08:05:00.000Z",
    durationSeconds: overrides.durationSeconds ?? 300,
    turns: overrides.turns ?? 2,
    messageCount: overrides.messageCount ?? 2,
    toolCallCount: overrides.toolCallCount ?? 0,
    tokens: overrides.tokens ?? { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
    cost: overrides.cost ?? { input: costTotal / 4, output: costTotal / 4, cacheCreation: costTotal / 4, cacheRead: costTotal / 4, total: costTotal },
    toolBreakdown: overrides.toolBreakdown ?? {},
    orchestrator: overrides.orchestrator,
  };
}
