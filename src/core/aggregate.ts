import fs from "node:fs/promises";
import path from "node:path";

import { getMachineId, getMachineName } from "./machine.js";
import { getRemoteMachinesDirectory, loadMachineDataFromPathSafe } from "./config.js";
import { loadMachineData } from "./data.js";
import { getSessionUsageEvents, localDayKey, windowSessionUsage } from "./usage-events.js";
import type {
  BreakdownItem,
  CostBreakdown,
  DataFilters,
  DataResponse,
  MachineData,
  MachineInfo,
  ProjectSummary,
  Session,
  TokenBreakdown,
} from "./types.js";

type RangeWindow = {
  currentStart: Date;
  currentEnd: Date;
  previousStart: Date;
  previousEnd: Date;
};

type BreakdownDimension = "source" | "model" | "machine" | "mars-task";

export async function aggregateData(filters: DataFilters = {}): Promise<DataResponse> {
  const localMachineId = await getMachineId();
  const localName = await getMachineName();
  const localData = await loadMachineData(localMachineId);
  // Reflect any rename even before the next collect() writes the data file.
  localData.name = localName;

  const remoteMachines = await loadRemoteMachines();
  const allMachines = [localData, ...remoteMachines];
  const nameById = new Map(allMachines.map((m) => [m.machineId, machineDisplayName(m)]));

  const allSessions = [...Object.values(localData.sessions), ...remoteMachines.flatMap((machine) => Object.values(machine.sessions))];
  const currentSessions = applyFilters(allSessions, filters);
  const comparisonSessions = applyComparisonFilters(allSessions, filters);

  return {
    machines: allMachines.map(toMachineInfo),
    sessions: sortSessionsByCreatedAt(currentSessions),
    totals: computeTotals(currentSessions),
    projects: buildProjectSummaries(currentSessions, comparisonSessions, nameById),
  };
}

export function applyFilters(sessions: Session[], filters: DataFilters = {}): Session[] {
  const window = getComparisonWindow(filters);
  return sessions.flatMap((session) => {
    if (!matchesNonTimeFilters(session, filters)) return [];
    if (!window) return [session];
    const windowed = windowSessionUsage(session, window.currentStart, window.currentEnd);
    return windowed ? [windowed] : [];
  });
}

export function applyComparisonFilters(sessions: Session[], filters: DataFilters = {}, now = Date.now()): Session[] {
  const comparisonWindow = getComparisonWindow(filters, now);
  if (!comparisonWindow) {
    return [];
  }

  return sessions.flatMap((session) => {
    if (!matchesNonTimeFilters(session, filters)) return [];
    const windowed = windowSessionUsage(session, comparisonWindow.previousStart, comparisonWindow.previousEnd);
    return windowed ? [windowed] : [];
  });
}

export function buildProjectSummaries(
  currentSessions: Session[],
  comparisonSessions: Session[],
  machineNameById?: Map<string, string>,
): ProjectSummary[] {
  const projectKeys = new Set(currentSessions.map((session) => session.project));

  return [...projectKeys]
    .map((projectKey) => computeProjectSummary(projectKey, currentSessions, comparisonSessions, machineNameById))
    .sort(compareProjectSummaries);
}

export function computeProjectSummary(
  projectKey: string,
  sessions: Session[],
  comparisonSessions: Session[],
  machineNameById?: Map<string, string>,
): ProjectSummary {
  const projectSessions = sessions.filter((session) => session.project === projectKey);
  const comparisonProjectSessions = comparisonSessions.filter((session) => session.project === projectKey);
  const totals = computeTotals(projectSessions);
  const sourceBreakdown = buildBreakdownItems(projectSessions, "source");
  const modelBreakdown = buildBreakdownItems(projectSessions, "model");
  const machineBreakdown = buildBreakdownItems(projectSessions, "machine", machineNameById);
  const totalTokens = totals.tokens.input + totals.tokens.output + totals.tokens.cacheCreation + totals.tokens.cacheRead;
  const previousCost = computeTotals(comparisonProjectSessions).cost.total;
  const trend = comparisonSessions.length > 0
    ? {
      previousCost,
      delta: totals.cost.total - previousCost,
      deltaPct: previousCost > 0 ? (totals.cost.total - previousCost) / previousCost : undefined,
    }
    : undefined;

  return {
    projectKey,
    projectLabel: projectKey,
    totalCost: totals.cost.total,
    totalTokens,
    sessionCount: projectSessions.length,
    totalTurns: totals.turns,
    avgCostPerSession: projectSessions.length === 0 ? 0 : totals.cost.total / projectSessions.length,
    avgTurnsPerSession: projectSessions.length === 0 ? 0 : totals.turns / projectSessions.length,
    activeDays: computeActiveDays(projectSessions),
    topSource: pickTopBreakdownItem(sourceBreakdown)?.label,
    topModel: pickTopBreakdownItem(modelBreakdown)?.label,
    topMachine: pickTopBreakdownItem(machineBreakdown)?.label,
    tokenBreakdown: totals.tokens,
    costBreakdown: totals.cost,
    sourceBreakdown,
    modelBreakdown,
    machineBreakdown,
    trend,
  };
}

export function computeActiveDays(sessions: Session[]): number {
  const days = new Set<string>();
  for (const session of sessions) {
    for (const event of getSessionUsageEvents(session)) {
      const date = new Date(event.at);
      if (!Number.isNaN(date.getTime())) days.add(localDayKey(date));
    }
  }
  return days.size;
}

export function buildBreakdownItems(
  sessions: Session[],
  dimension: BreakdownDimension,
  machineNameById?: Map<string, string>,
): BreakdownItem[] {
  const grouped = new Map<string, BreakdownItem>();

  for (const session of sessions) {
    if (dimension === "model") {
      const seenModels = new Set<string>();
      for (const event of getSessionUsageEvents(session)) {
        const model = event.model || "unknown";
        if (model === "unknown") continue;
        const item = grouped.get(model) ?? { key: model, label: model, cost: 0, sessions: 0 };
        item.cost += event.cost?.total ?? 0;
        if (!seenModels.has(model)) {
          item.sessions += 1;
          seenModels.add(model);
        }
        grouped.set(model, item);
      }
      continue;
    }
    const { key, label } = getBreakdownIdentity(session, dimension, machineNameById);
    const item = grouped.get(key) ?? { key, label, cost: 0, sessions: 0 };
    item.cost += session.cost.total;
    item.sessions += 1;
    grouped.set(key, item);
  }

  return [...grouped.values()].sort(compareBreakdownItems);
}

export function pickTopBreakdownItem(items: BreakdownItem[]): BreakdownItem | undefined {
  return items[0];
}

export function computeTotals(sessions: Session[]): DataResponse["totals"] {
  const tokens: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const cost: CostBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
  let turns = 0;
  let durationSeconds = 0;

  for (const session of sessions) {
    turns += session.turns;
    durationSeconds += session.durationSeconds;
    tokens.input += session.tokens.input;
    tokens.output += session.tokens.output;
    tokens.cacheCreation += session.tokens.cacheCreation;
    tokens.cacheRead += session.tokens.cacheRead;
    cost.input += session.cost.input;
    cost.output += session.cost.output;
    cost.cacheCreation += session.cost.cacheCreation;
    cost.cacheRead += session.cost.cacheRead;
    cost.total += session.cost.total;
  }

  const totalPromptTokens = tokens.input + tokens.cacheCreation + tokens.cacheRead;
  const cacheHitRate = totalPromptTokens === 0 ? 0 : tokens.cacheRead / totalPromptTokens;

  return {
    sessions: sessions.length,
    turns,
    durationSeconds,
    tokens,
    cost,
    cacheHitRate,
  };
}

export function getComparisonWindow(filters: DataFilters = {}, now = Date.now()): RangeWindow | null {
  if (filters.days) {
    const currentEnd = new Date(now);
    const currentStart = new Date(now - filters.days * 24 * 60 * 60 * 1000);
    const previousEnd = new Date(currentStart);
    const previousStart = new Date(currentStart.getTime() - filters.days * 24 * 60 * 60 * 1000);
    return { currentStart, currentEnd, previousStart, previousEnd };
  }

  if (filters.months) {
    const currentEnd = new Date(now);
    const currentStart = new Date(now);
    currentStart.setMonth(currentStart.getMonth() - filters.months);
    const previousEnd = new Date(currentStart);
    const previousStart = new Date(currentStart);
    previousStart.setMonth(previousStart.getMonth() - filters.months);
    return { currentStart, currentEnd, previousStart, previousEnd };
  }

  return null;
}

function matchesNonTimeFilters(session: Session, filters: DataFilters): boolean {
  if (filters.project && session.project !== filters.project) {
    return false;
  }

  if (filters.machine && session.machineId !== filters.machine) {
    return false;
  }

  if (filters.orchestrator === "none") {
    return session.orchestrator === undefined;
  }

  if (filters.orchestrator) {
    return session.orchestrator?.kind === filters.orchestrator;
  }

  return true;
}

function getBreakdownIdentity(
  session: Session,
  dimension: BreakdownDimension,
  machineNameById?: Map<string, string>,
): { key: string; label: string } {
  if (dimension === "source") {
    return { key: session.source, label: session.source };
  }

  if (dimension === "model") {
    return { key: session.model, label: session.model };
  }

  if (dimension === "mars-task") {
    if (session.orchestrator?.kind === "mars" && session.orchestrator.taskTitle) {
      return { key: session.orchestrator.taskTitle, label: session.orchestrator.taskTitle };
    }
    return { key: "__untagged__", label: "__untagged__" };
  }

  const label = machineNameById?.get(session.machineId) ?? session.machineId;
  return { key: session.machineId, label };
}

function compareProjectSummaries(left: ProjectSummary, right: ProjectSummary): number {
  return right.totalCost - left.totalCost
    || right.sessionCount - left.sessionCount
    || left.projectLabel.localeCompare(right.projectLabel);
}

function compareBreakdownItems(left: BreakdownItem, right: BreakdownItem): number {
  return right.cost - left.cost
    || right.sessions - left.sessions
    || left.label.localeCompare(right.label);
}

function sortSessionsByCreatedAt(sessions: Session[]): Session[] {
  return [...sessions].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

async function loadRemoteMachines(): Promise<MachineData[]> {
  const remoteDir = getRemoteMachinesDirectory();
  const files = await fs.readdir(remoteDir).catch(() => []);
  const machines = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => loadMachineDataFromPathSafe(path.join(remoteDir, file))));
  return machines.filter((machine): machine is MachineData => machine !== null);
}

function machineDisplayName(machine: MachineData): string {
  return machine.name?.trim() || machine.hostname || machine.machineId;
}

function toMachineInfo(machine: MachineData): MachineInfo {
  return {
    machineId: machine.machineId,
    name: machineDisplayName(machine),
    hostname: machine.hostname,
    sessionCount: Object.keys(machine.sessions).length,
    lastUpdatedAt: machine.lastUpdatedAt,
  };
}
