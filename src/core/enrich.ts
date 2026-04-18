import { loadConfig } from "./config.js";
import { calculateSessionCost } from "./pricing.js";
import { resolveProject } from "./project.js";
import type { Session } from "./types.js";

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
  const cost = await calculateSessionCost(new Date(session.createdAt), session.tokens, session.model, session.source);

  return {
    ...session,
    machineId,
    project: resolvedProject,
    cost,
  };
}
