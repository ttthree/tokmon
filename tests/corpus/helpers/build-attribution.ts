import { claimedCcSessionIds } from "../../../src/parsers/eureka.js";
import type { Session, TokenBreakdown } from "../../../src/core/types.js";

export interface AttributionGolden {
  summary: {
    totalSessions: number;
    perSource: Record<string, number>;
    perEngine: Record<string, number>;
    marsSessionCount: number;
  };
  eurekaLinkage: Array<{
    eurekaSessionId: string;
    engine: string;
    tokens: TokenBreakdown;
    resolved: boolean;
  }>;
  marsTrees: Array<{
    taskId: string;
    taskTitle: string;
    sessionIds: string[];
    totalCost: number;
    totalTokens: number;
  }>;
  claimedCcSessionIds: string[];
  doubleCounting: {
    ccIdsBothStandaloneAndClaimed: string[];
  };
}

export function buildAttribution(sessions: Session[]): AttributionGolden {
  const claimedIds = [...claimedCcSessionIds].sort();
  const standaloneCcIds = new Set(sessions.filter((session) => session.source === "claude-code").map((session) => session.id));

  return {
    summary: {
      totalSessions: sessions.length,
      perSource: countBy(sessions, (session) => session.source),
      perEngine: countBy(sessions, (session) => session.engine ?? "unknown"),
      marsSessionCount: sessions.filter((session) => session.orchestrator?.kind === "mars").length,
    },
    eurekaLinkage: sessions
      .filter((session) => session.orchestrator?.kind === "eureka")
      .map((session) => ({
        eurekaSessionId: session.id,
        engine: session.engine ?? "unknown",
        tokens: { ...session.tokens },
        resolved: totalTokens(session.tokens) > 0,
      }))
      .sort((left, right) => left.eurekaSessionId.localeCompare(right.eurekaSessionId)),
    marsTrees: buildMarsTrees(sessions),
    claimedCcSessionIds: claimedIds,
    doubleCounting: {
      ccIdsBothStandaloneAndClaimed: claimedIds.filter((id) => standaloneCcIds.has(id)),
    },
  };
}

function buildMarsTrees(sessions: Session[]): AttributionGolden["marsTrees"] {
  const grouped = new Map<string, AttributionGolden["marsTrees"][number]>();

  for (const session of sessions) {
    if (session.orchestrator?.kind !== "mars" || !session.orchestrator.taskId) continue;
    const taskId = session.orchestrator.taskId;
    const entry = grouped.get(taskId) ?? {
      taskId,
      taskTitle: session.orchestrator.taskTitle ?? "",
      sessionIds: [],
      totalCost: 0,
      totalTokens: 0,
    };
    if (!entry.taskTitle && session.orchestrator.taskTitle) {
      entry.taskTitle = session.orchestrator.taskTitle;
    }
    entry.sessionIds.push(session.id);
    entry.totalCost += session.cost.total;
    entry.totalTokens += totalTokens(session.tokens);
    grouped.set(taskId, entry);
  }

  return [...grouped.values()]
    .map((entry) => ({
      ...entry,
      sessionIds: [...entry.sessionIds].sort(),
      totalCost: roundFloat(entry.totalCost),
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function totalTokens(tokens: TokenBreakdown): number {
  return tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
}

function roundFloat(value: number): number {
  return Number(value.toFixed(12));
}
