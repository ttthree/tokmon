import fs from "node:fs/promises";
import os from "node:os";

import { createEmptyCursorState } from "./cursor.js";
import { ensureTokmonDirectories, getMachineDataPath, loadMachineDataFromPath, pathExists } from "./config.js";
import type { CursorState, MachineData, Session } from "./types.js";

export function getSessionKey(machineId: string, session: Pick<Session, "source" | "id">): string {
  return `${machineId}:${session.source}:${session.id}`;
}

export function createEmptyMachineData(machineId: string, name?: string): MachineData {
  const hostname = os.hostname();
  return {
    machineId,
    name: name ?? hostname,
    hostname,
    os: `${process.platform}-${process.arch}`,
    lastUpdatedAt: new Date(0).toISOString(),
    sessions: {},
    _cursor: createEmptyCursorState(),
  };
}

export async function loadMachineData(machineId: string): Promise<MachineData> {
  await ensureTokmonDirectories();
  const machinePath = getMachineDataPath(machineId);
  if (!(await pathExists(machinePath))) {
    return createEmptyMachineData(machineId);
  }
  return loadMachineDataFromPath(machinePath);
}

export async function saveMachineData(machineData: MachineData, name?: string): Promise<void> {
  await ensureTokmonDirectories();
  machineData.lastUpdatedAt = new Date().toISOString();
  if (name !== undefined) {
    machineData.name = name;
  }
  await fs.writeFile(getMachineDataPath(machineData.machineId), JSON.stringify(machineData, null, 2) + "\n", "utf8");
}

export function mergeSession(existing: Session | undefined, updated: Session): Session {
  if (!existing) {
    return updated;
  }
  return {
    ...updated,
    createdAt: existing.createdAt,
  };
}

export function updateSessions(existing: Record<string, Session>, newSessions: Session[], machineId: string): Record<string, Session> {
  const result = { ...existing };
  for (const session of newSessions) {
    const key = getSessionKey(machineId, session);
    result[key] = mergeSession(result[key], session);
  }
  return result;
}

export function replaceCursor(machineData: MachineData, cursor: CursorState): MachineData {
  return {
    ...machineData,
    _cursor: cursor,
  };
}
