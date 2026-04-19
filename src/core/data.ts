import fs from "node:fs/promises";
import os from "node:os";

import { createEmptyCursorState } from "./cursor.js";
import { ensureTokmonDirectories, getMachineDataPath, loadMachineDataFromPath, pathExists } from "./config.js";
import { inferSourceFromEngine } from "./orchestrator.js";
import type { CursorState, MachineData, Session } from "./types.js";

export { inferSourceFromEngine } from "./orchestrator.js";

const LEGACY_SOURCE_MIGRATION_FLAG = "__legacySourceMigrationApplied";

type LoadMigrationMeta = MachineData & {
  [LEGACY_SOURCE_MIGRATION_FLAG]?: boolean;
};

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

  const machineData = await loadMachineDataFromPath(machinePath) as LoadMigrationMeta;
  if (machineData[LEGACY_SOURCE_MIGRATION_FLAG]) {
    await saveMachineData(machineData);
  }
  return machineData;
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

export function normalizeLegacySources(machine: MachineData): MachineData {
  const fixed: Record<string, Session> = {};

  for (const session of Object.values(machine.sessions)) {
    const raw = session as Omit<Session, "source"> & { source: string };
    if (raw.source === "eureka") {
      const migrated: Session = {
        ...raw,
        source: inferSourceFromEngine(raw.engine ?? ""),
        orchestrator: raw.orchestrator ?? { kind: "eureka" },
      };
      const key = getSessionKey(machine.machineId, migrated);
      fixed[key] = fixed[key] ? pickFresher(fixed[key], migrated) : migrated;
      continue;
    }

    const direct = raw as Session;
    const key = getSessionKey(machine.machineId, direct);
    fixed[key] = fixed[key] ? pickFresher(fixed[key], direct) : direct;
  }

  return { ...machine, sessions: fixed };
}

export function pickFresher(a: Session, b: Session): Session {
  if (a.cost.total > 0 && b.cost.total === 0) return a;
  if (b.cost.total > 0 && a.cost.total === 0) return b;
  return Date.parse(b.modifiedAt) >= Date.parse(a.modifiedAt) ? b : a;
}

export function tagLegacySourceMigration(machine: MachineData): MachineData {
  const migrated = normalizeLegacySources(machine) as LoadMigrationMeta;
  const changed = didLegacySourceMigrationChange(machine, migrated);
  if (!changed) return migrated;
  Object.defineProperty(migrated, LEGACY_SOURCE_MIGRATION_FLAG, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return migrated;
}

function didLegacySourceMigrationChange(before: MachineData, after: MachineData): boolean {
  const beforeEntries = Object.entries(before.sessions);
  const afterEntries = Object.entries(after.sessions);
  if (beforeEntries.length !== afterEntries.length) return true;

  const afterMap = new Map(afterEntries);
  for (const [key, session] of beforeEntries) {
    const migrated = afterMap.get(key);
    if (!migrated) return true;
    if (session.source !== migrated.source) return true;
    if (session.orchestrator?.kind !== migrated.orchestrator?.kind) return true;
  }

  return false;
}
