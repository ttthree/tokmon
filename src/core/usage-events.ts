import type { CostBreakdown, Session, TokenBreakdown, UsageEvent } from "./types.js";

export interface UsageBucket {
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  sessions: Set<string>;
}

export interface WindowedSessionUsage {
  events: UsageEvent[];
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  modelUsage: Record<string, TokenBreakdown>;
}

export function emptyTokens(): TokenBreakdown {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

export function emptyCost(): CostBreakdown {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
}

export function getSessionUsageEvents(session: Session): UsageEvent[] {
  if (session.usageEvents && session.usageEvents.length > 0) {
    return session.usageEvents;
  }
  return [{
    at: session.createdAt,
    model: session.model || "unknown",
    tokens: { ...session.tokens },
    cost: { ...session.cost },
    requestId: `${session.id}:legacy`,
  }];
}

export function sumUsageEvents(events: UsageEvent[]): { tokens: TokenBreakdown; cost: CostBreakdown } {
  const tokens = emptyTokens();
  const cost = emptyCost();
  for (const event of events) {
    addTokens(tokens, event.tokens);
    if (event.cost) addCost(cost, event.cost);
  }
  return { tokens, cost };
}

export function filterUsageEventsByWindow(events: UsageEvent[], start?: Date, end?: Date): UsageEvent[] {
  if (!start && !end) return events;
  const startMs = start?.getTime();
  const endMs = end?.getTime();
  return events.filter((event) => {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) return false;
    if (startMs !== undefined && at < startMs) return false;
    if (endMs !== undefined && at >= endMs) return false;
    return true;
  });
}

export function bucketUsageEventsByDay(events: UsageEvent[]): Map<string, UsageBucket> {
  const buckets = new Map<string, UsageBucket>();
  for (const event of events) {
    const date = new Date(event.at);
    if (Number.isNaN(date.getTime())) continue;
    const key = localDayKey(date);
    const bucket = buckets.get(key) ?? { tokens: emptyTokens(), cost: emptyCost(), sessions: new Set<string>() };
    addTokens(bucket.tokens, event.tokens);
    if (event.cost) addCost(bucket.cost, event.cost);
    buckets.set(key, bucket);
  }
  return buckets;
}

export function getSessionUsageForWindow(session: Session, start?: Date, end?: Date): WindowedSessionUsage {
  const events = filterUsageEventsByWindow(getSessionUsageEvents(session), start, end);
  const { tokens, cost } = sumUsageEvents(events);
  return { events, tokens, cost, modelUsage: buildModelUsage(events) };
}

export function windowSessionUsage(session: Session, start?: Date, end?: Date): Session | null {
  const usage = getSessionUsageForWindow(session, start, end);
  if (usage.events.length === 0) return null;
  return {
    ...session,
    usageEvents: usage.events,
    tokens: usage.tokens,
    cost: usage.cost,
    modelUsage: Object.keys(usage.modelUsage).length > 0 ? usage.modelUsage : undefined,
  };
}

export function buildModelUsage(events: UsageEvent[]): Record<string, TokenBreakdown> {
  const modelUsage: Record<string, TokenBreakdown> = {};
  for (const event of events) {
    const model = event.model || "unknown";
    const bucket = modelUsage[model] ?? (modelUsage[model] = emptyTokens());
    addTokens(bucket, event.tokens);
  }
  return modelUsage;
}

export function addTokens(target: TokenBreakdown, delta: TokenBreakdown): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheCreation += delta.cacheCreation;
  target.cacheRead += delta.cacheRead;
}

export function addCost(target: CostBreakdown, delta: CostBreakdown): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheCreation += delta.cacheCreation;
  target.cacheRead += delta.cacheRead;
  target.total += delta.total;
}

export function hasAnyTokens(tokens: TokenBreakdown): boolean {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheCreation > 0 || tokens.cacheRead > 0;
}

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
