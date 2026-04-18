import {
  buildBreakdownItems,
  buildProjectSummaries,
  computeTotals,
} from "../../../src/core/aggregate.js";
import type {
  BreakdownItem,
  ProjectSummary,
  Session,
} from "../../../src/core/types.js";

export interface PerDayAggregate {
  date: string;
  cost: number;
  sessions: number;
  tokens: number;
}

export interface AggregatesGolden {
  totals: ReturnType<typeof computeTotals>;
  perSource: BreakdownItem[];
  perModel: BreakdownItem[];
  perMachine: BreakdownItem[];
  perMarsTask: BreakdownItem[];
  perDay: PerDayAggregate[];
  projects: ProjectSummary[];
  leaderboards: {
    topProjects: string[];
    topModels: string[];
  };
}

export function aggregateFromSessions(sessions: Session[]): AggregatesGolden {
  const machineNameById = new Map([...new Set(sessions.map((session) => session.machineId))].map((id) => [id, id]));
  const totals = roundTotals(computeTotals(sessions));
  const perSource = roundBreakdownItems(buildBreakdownItems(sessions, "source"));
  const perModel = roundBreakdownItems(buildBreakdownItems(sessions, "model"));
  const perMachine = roundBreakdownItems(buildBreakdownItems(sessions, "machine", machineNameById));
  const perMarsTask = roundBreakdownItems(buildBreakdownItems(sessions, "mars-task"));
  const projects = buildProjectSummaries(sessions, [], machineNameById).map(roundProjectSummary);

  return {
    totals,
    perSource,
    perModel,
    perMachine,
    perMarsTask,
    perDay: buildPerDay(sessions),
    projects,
    leaderboards: {
      topProjects: projects.slice(0, 10).map((project) => project.projectKey),
      topModels: perModel.slice(0, 10).map((model) => model.key),
    },
  };
}

function buildPerDay(sessions: Session[]): PerDayAggregate[] {
  const grouped = new Map<string, PerDayAggregate>();

  for (const session of sessions) {
    const date = session.createdAt.slice(0, 10);
    const entry = grouped.get(date) ?? { date, cost: 0, sessions: 0, tokens: 0 };
    entry.cost += session.cost.total;
    entry.sessions += 1;
    entry.tokens += totalTokens(session);
    grouped.set(date, entry);
  }

  return [...grouped.values()]
    .map((entry) => ({ ...entry, cost: roundFloat(entry.cost) }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function totalTokens(session: Session): number {
  return session.tokens.input + session.tokens.output + session.tokens.cacheCreation + session.tokens.cacheRead;
}

function roundTotals(totals: ReturnType<typeof computeTotals>): ReturnType<typeof computeTotals> {
  return {
    ...totals,
    cost: roundCostBreakdown(totals.cost),
    cacheHitRate: roundFloat(totals.cacheHitRate),
  };
}

function roundProjectSummary(project: ProjectSummary): ProjectSummary {
  return {
    ...project,
    totalCost: roundFloat(project.totalCost),
    avgCostPerSession: roundFloat(project.avgCostPerSession),
    costBreakdown: roundCostBreakdown(project.costBreakdown),
    sourceBreakdown: roundBreakdownItems(project.sourceBreakdown),
    modelBreakdown: roundBreakdownItems(project.modelBreakdown),
    machineBreakdown: roundBreakdownItems(project.machineBreakdown),
    trend: project.trend
      ? {
          previousCost: roundFloat(project.trend.previousCost),
          delta: roundFloat(project.trend.delta),
          deltaPct: project.trend.deltaPct,
        }
      : undefined,
  };
}

function roundBreakdownItems(items: BreakdownItem[]): BreakdownItem[] {
  return items.map((item) => ({ ...item, cost: roundFloat(item.cost) }));
}

function roundCostBreakdown(cost: ProjectSummary["costBreakdown"]): ProjectSummary["costBreakdown"] {
  return {
    input: roundFloat(cost.input),
    output: roundFloat(cost.output),
    cacheCreation: roundFloat(cost.cacheCreation),
    cacheRead: roundFloat(cost.cacheRead),
    total: roundFloat(cost.total),
  };
}

function roundFloat(value: number): number {
  return Number(value.toFixed(12));
}
