import fs from "node:fs/promises";
import os from "node:os";

import { createEmptyCursorState } from "./cursor.js";
import { ensureTokmonDirectories, getMachineDataPath, loadMachineDataFromPath, pathExists } from "./config.js";
import { logDiag } from "./diag-log.js";
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
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(machineData, null, 2) + "\n";
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, finalPath);
}

export function mergeSession(existing: Session | undefined, updated: Session): Session {
  if (!existing) {
    return updated;
  }
  const preferred = preferSession(existing, updated);
  const createdAt = pickEarlierCreatedAt(existing.createdAt, updated.createdAt);
  return {
    ...preferred,
    createdAt,
  };
}

export function preferSession(left: Session, right: Session): Session {
  const leftRank = tokenProvenanceRank(left.tokenProvenance);
  const rightRank = tokenProvenanceRank(right.tokenProvenance);
  if (rightRank !== leftRank) {
    return rightRank > leftRank ? right : left;
  }

  const leftTokens = totalTokens(left);
  const rightTokens = totalTokens(right);
  if (rightTokens !== leftTokens) {
    return rightTokens > leftTokens ? right : left;
  }

  const leftCost = left.cost.total;
  const rightCost = right.cost.total;
  if (rightCost !== leftCost) {
    return rightCost > leftCost ? right : left;
  }

  return Date.parse(right.modifiedAt) >= Date.parse(left.modifiedAt) ? right : left;
}

function tokenProvenanceRank(provenance: Session["tokenProvenance"]): number {
  switch (provenance) {
    case "sdk-cc-jsonl":
    case "sdk-codex-rollout":
    case "sdk-pi-jsonl":
      return 5;
    case "sdk-shutdown":
      return 4;
    case "sdk-events":
      return 3;
    case "telemetry":
      return 2;
    case "none":
    case undefined:
    default:
      return 1;
  }
}

function totalTokens(session: Session): number {
  return session.tokens.input + session.tokens.output + session.tokens.cacheCreation + session.tokens.cacheRead;
}

export function updateSessions(existing: Record<string, Session>, newSessions: Session[], machineId: string): Record<string, Session> {
  const result = { ...existing };
  const orchestratedKeysById = indexOrchestratedSessionKeys(result, machineId);

  for (const session of newSessions) {
    const key = getSessionKey(machineId, session);
    const orchestratedId = getOrchestratedSessionId(session);
    if (orchestratedId) {
      for (const existingKey of orchestratedKeysById.get(orchestratedId) ?? []) {
        if (existingKey !== key) delete result[existingKey];
      }
      orchestratedKeysById.set(orchestratedId, [key]);
    }
    result[key] = mergeSession(result[key], session);
  }
  return result;
}

function indexOrchestratedSessionKeys(sessions: Record<string, Session>, machineId: string): Map<string, string[]> {
  const keysById = new Map<string, string[]>();
  const prefix = `${machineId}:`;
  for (const [key, session] of Object.entries(sessions)) {
    if (!key.startsWith(prefix)) continue;
    const orchestratedId = getOrchestratedSessionId(session);
    if (!orchestratedId) continue;
    keysById.set(orchestratedId, [...(keysById.get(orchestratedId) ?? []), key]);
  }
  return keysById;
}

function getOrchestratedSessionId(session: Session): string | null {
  const kind = session.orchestrator?.kind;
  return kind === "eureka" || kind === "mars" ? `${kind}:${session.id}` : null;
}

export function replaceCursor(machineData: MachineData, cursor: CursorState): MachineData {
  return {
    ...machineData,
    _cursor: cursor,
  };
}

export function sanitizeLoadedMachineData(machine: MachineData): MachineData {
  return normalizeLegacySources(machine);
}

export function normalizeLegacySources(machine: MachineData): MachineData {
  const fixed: Record<string, Session> = {};
  let migratedEurekaCount = 0;
  let collidedCount = 0;
  let droppedGhostCount = 0;

  for (const session of Object.values(machine.sessions)) {
    const raw = session as Omit<Session, "source"> & { source: string };
    if (raw.source === "eureka") {
      const migrated: Session = {
        ...raw,
        source: inferSourceFromEngine(raw.engine ?? ""),
        orchestrator: raw.orchestrator ?? { kind: "eureka" },
      };
      if (shouldDropGhostSession(migrated)) {
        droppedGhostCount++;
        continue;
      }
      const key = getSessionKey(machine.machineId, migrated);
      if (fixed[key]) collidedCount++;
      fixed[key] = fixed[key] ? pickFresher(fixed[key], migrated) : normalizeSessionTimestamps(migrated);
      migratedEurekaCount++;
      continue;
    }

    const direct = raw as Session;
    if (shouldDropGhostSession(direct)) {
      droppedGhostCount++;
      continue;
    }
    const key = getSessionKey(machine.machineId, direct);
    if (fixed[key]) collidedCount++;
    fixed[key] = fixed[key] ? pickFresher(fixed[key], direct) : normalizeSessionTimestamps(direct);
  }

  if (migratedEurekaCount > 0 || collidedCount > 0 || droppedGhostCount > 0) {
    void logDiag({
      event: "normalizeLegacySources",
      machineId: machine.machineId,
      inputCount: Object.keys(machine.sessions).length,
      outputCount: Object.keys(fixed).length,
      migratedEurekaCount,
      collidedCount,
      droppedGhostCount,
    });
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
    if (session.createdAt !== migrated.createdAt) return true;
    if (session.modifiedAt !== migrated.modifiedAt) return true;
  }

  return false;
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
  const hasUsage = totalTokens(session) > 0 || session.cost.total > 0;
  if (hasUsage) {
    return false;
  }
  const hasPlaceholderCreated = parseValidSessionTime(session.createdAt) === null;
  const hasPlaceholderModified = parseValidSessionTime(session.modifiedAt) === null;
  return (session.tokenProvenance === undefined || session.tokenProvenance === "none")
    && hasPlaceholderCreated
    && hasPlaceholderModified;
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
