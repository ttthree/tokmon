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
  return sanitizeLoadedMachineData(await loadMachineDataFromPath(machinePath));
}

export async function saveMachineData(machineData: MachineData, name?: string): Promise<void> {
  // Serialize concurrent writes per machineId so racing callers don't both try
  // to rename the same .tmp (causes ENOENT for the loser).
  const id = machineData.machineId;
  const previous = saveMachineQueues.get(id) ?? Promise.resolve();
  const next = previous.then(
    () => doSaveMachineData(machineData, name),
    () => doSaveMachineData(machineData, name),
  );
  saveMachineQueues.set(id, next);
  try {
    await next;
  } finally {
    if (saveMachineQueues.get(id) === next) {
      saveMachineQueues.delete(id);
    }
  }
}

const saveMachineQueues = new Map<string, Promise<void>>();

async function doSaveMachineData(machineData: MachineData, name?: string): Promise<void> {
  await ensureTokmonDirectories();
  machineData.lastUpdatedAt = new Date().toISOString();
  if (name !== undefined) {
    machineData.name = name;
  }
  const finalPath = getMachineDataPath(machineData.machineId);
  // Per-process unique tmp path to survive concurrent writers across processes.
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(machineData, null, 2) + "\n";
  // Atomic write: write to tempfile then rename. POSIX rename is atomic on
  // the same filesystem, so Ctrl+C during the write can't leave the final
  // file truncated. Worst case: a stray .tmp is left behind.
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, finalPath);
}

export function mergeSession(existing: Session | undefined, updated: Session): Session {
  if (!existing) {
    return updated;
  }
  return {
    ...updated,
    createdAt: pickEarlierCreatedAt(existing.createdAt, updated.createdAt),
  };
}

export function sanitizeLoadedMachineData(machineData: MachineData): MachineData {
  let changed = false;
  const sessions = Object.fromEntries(Object.entries(machineData.sessions).flatMap(([key, session]) => {
    if (shouldDropGhostSession(session)) {
      changed = true;
      return [];
    }
    const normalized = normalizeSessionTimestamps(session);
    if (normalized !== session) {
      changed = true;
    }
    return [[key, normalized]];
  }));

  if (!changed) {
    return machineData;
  }

  return {
    ...machineData,
    sessions,
  };
}

function pickEarlierCreatedAt(left: string, right: string): string {
  const leftMs = parseValidSessionTime(left);
  const rightMs = parseValidSessionTime(right);
  if (leftMs !== null && rightMs !== null) {
    return leftMs <= rightMs ? left : right;
  }
  if (leftMs !== null) return left;
  if (rightMs !== null) return right;
  return left < right ? left : right;
}

function normalizeSessionTimestamps(session: Session): Session {
  const createdMs = parseValidSessionTime(session.createdAt);
  const modifiedMs = parseValidSessionTime(session.modifiedAt);
  if (createdMs !== null && modifiedMs !== null) {
    return session;
  }
  if (createdMs !== null) {
    return { ...session, modifiedAt: session.createdAt };
  }
  if (modifiedMs !== null) {
    return { ...session, createdAt: session.modifiedAt };
  }
  return session;
}

function shouldDropGhostSession(session: Session): boolean {
  const hasUsage = session.tokens.input > 0
    || session.tokens.output > 0
    || session.tokens.cacheCreation > 0
    || session.tokens.cacheRead > 0
    || session.cost.total > 0;
  if (hasUsage) {
    return false;
  }
  return (session.tokenProvenance === undefined || session.tokenProvenance === "none")
    && parseValidSessionTime(session.createdAt) === null
    && parseValidSessionTime(session.modifiedAt) === null;
}

function parseValidSessionTime(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const year = new Date(parsed).getUTCFullYear();
  if (year < 2000 || year > 2100) {
    return null;
  }
  return parsed;
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
