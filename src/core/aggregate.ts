import fs from "node:fs/promises";
import path from "node:path";

import { getMachineId } from "./machine.js";
import { getRemoteMachinesDirectory, loadMachineDataFromPathSafe } from "./config.js";
import { loadMachineData } from "./data.js";
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

type BreakdownDimension = "source" | "model" | "machine";

export async function aggregateData(filters: DataFilters = {}): Promise<DataResponse> {
  const localMachineId = await getMachineId();
  const localData = await loadMachineData(localMachineId);

  const remoteMachines = await loadRemoteMachines();
  const allSessions = [...Object.values(localData.sessions), ...remoteMachines.flatMap((machine) => Object.values(machine.sessions))];
  const currentSessions = applyFilters(allSessions, filters);
  const comparisonSessions = applyComparisonFilters(allSessions, filters);

  return {
    machines: [localData, ...remoteMachines].map(toMachineInfo),
    sessions: sortSessionsByCreatedAt(currentSessions),
    totals: computeTotals(currentSessions),
    projects: buildProjectSummaries(currentSessions, comparisonSessions),
  };
}

export function applyFilters(sessions: Session[], filters: DataFilters = {}): Session[] {
  return sessions.filter((session) => matchesFilters(session, filters));
}

export function applyComparisonFilters(sessions: Session[], filters: DataFilters = {}, now = Date.now()): Session[] {
  const comparisonWindow = getComparisonWindow(filters, now);
  if (!comparisonWindow) {
    return [];
  }

  return sessions.filter((session) => matchesFilters(session, filters, comparisonWindow.previousStart, comparisonWindow.previousEnd));
}

export function buildProjectSummaries(currentSessions: Session[], comparisonSessions: Session[]): ProjectSummary[] {
  const projectKeys = new Set(currentSessions.map((session) => session.project));

  return [...projectKeys]
    .map((projectKey) => computeProjectSummary(projectKey, currentSessions, comparisonSessions))
    .sort(compareProjectSummaries);
}

export function computeProjectSummary(projectKey: string, sessions: Session[], comparisonSessions: Session[]): ProjectSummary {
  const projectSessions = sessions.filter((session) => session.project === projectKey);
  const comparisonProjectSessions = comparisonSessions.filter((session) => session.project === projectKey);
  const totals = computeTotals(projectSessions);
  const sourceBreakdown = buildBreakdownItems(projectSessions, "source");
  const modelBreakdown = buildBreakdownItems(projectSessions, "model");
  const machineBreakdown = buildBreakdownItems(projectSessions, "machine");
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
  return new Set(sessions.map((session) => session.createdAt.slice(0, 10))).size;
}

export function buildBreakdownItems(sessions: Session[], dimension: BreakdownDimension): BreakdownItem[] {
  const grouped = new Map<string, BreakdownItem>();

  for (const session of sessions) {
    const { key, label } = getBreakdownIdentity(session, dimension);
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

function matchesFilters(session: Session, filters: DataFilters, rangeStart?: Date, rangeEnd?: Date): boolean {
  const createdAt = new Date(session.createdAt);

  if (rangeStart && createdAt < rangeStart) {
    return false;
  }

  if (rangeEnd && createdAt >= rangeEnd) {
    return false;
  }

  if (!rangeStart && !rangeEnd) {
    const currentWindow = getComparisonWindow(filters);
    if (currentWindow && (createdAt < currentWindow.currentStart || createdAt >= currentWindow.currentEnd)) {
      return false;
    }
  }

  if (filters.project && session.project !== filters.project) {
    return false;
  }

  if (filters.machine && session.machineId !== filters.machine) {
    return false;
  }

  return true;
}

function getBreakdownIdentity(session: Session, dimension: BreakdownDimension): { key: string; label: string } {
  if (dimension === "source") {
    return { key: session.source, label: session.source };
  }

  if (dimension === "model") {
    return { key: session.model, label: session.model };
  }

  return { key: session.machineId, label: session.machineId };
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

function toMachineInfo(machine: MachineData): MachineInfo {
  return {
    machineId: machine.machineId,
    hostname: machine.hostname,
    sessionCount: Object.keys(machine.sessions).length,
    lastUpdatedAt: machine.lastUpdatedAt,
  };
}
