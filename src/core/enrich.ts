import { loadConfig } from "./config.js";
import { calculateCost, loadPricingForDate, lookupPricing } from "./pricing.js";
import { resolveProject } from "./project.js";
import { buildModelUsage, getSessionUsageEvents, sumUsageEvents } from "./usage-events.js";
import type { LiteLLMPricing, Session } from "./types.js";

const pricingByDay = new Map<string, Promise<LiteLLMPricing>>();

export async function enrichSessionsBatched(
  sessions: Session[],
  machineId: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  onProgress: (done: number, total: number) => void,
): Promise<Session[]> {
  const results: Session[] = [];
  const BATCH = 200;
  for (let i = 0; i < sessions.length; i += BATCH) {
    const batch = sessions.slice(i, i + BATCH);
    const enriched = await Promise.all(batch.map((s) => enrichSession(s, machineId, config)));
    results.push(...enriched);
    if (i + BATCH < sessions.length) {
      onProgress(results.length, sessions.length);
    }
  }
  return results;
}

export async function enrichSession(session: Session, machineId: string, config: Awaited<ReturnType<typeof loadConfig>>): Promise<Session> {
  const resolvedProject = await resolveProject(session.projectPath, config);
  const sourceEvents = getSessionUsageEvents(session);
  const usageEvents = [];
  for (const event of sourceEvents) {
    const eventDate = new Date(event.at);
    const pricingData = await getPricingForDay(eventDate);
    const pricing = lookupPricing(pricingData, event.model || session.model, session.source);
    usageEvents.push({
      ...event,
      tokens: { ...event.tokens },
      cost: calculateCost(event.tokens, pricing),
    });
  }
  const { tokens, cost } = sumUsageEvents(usageEvents);
  const modelUsage = buildModelUsage(usageEvents);

  return {
    ...session,
    machineId,
    project: resolvedProject,
    tokens,
    cost,
    modelUsage: Object.keys(modelUsage).length > 0 ? modelUsage : undefined,
    usageEvents,
  };
}


async function getPricingForDay(date: Date): Promise<LiteLLMPricing> {
  const key = Number.isNaN(date.getTime()) ? "invalid" : date.toISOString().slice(0, 10);
  let promise = pricingByDay.get(key);
  if (!promise) {
    promise = loadPricingForDate(date).then((snapshot) => snapshot?.pricing ?? {});
    pricingByDay.set(key, promise);
  }
  return promise;
}
