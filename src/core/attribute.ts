import path from "node:path";

import { computeActiveDurationSeconds } from "./duration.js";
import { normalizeProjectPath } from "./project.js";
import type { Session } from "./types.js";
import { preferSession } from "./data.js";
import { applyMarsMeta } from "../parsers/orchestrator.js";
import type { EurekaIndex, EurekaIndexEntry } from "../parsers/eureka-index.js";
import { eurekaEngineLabel, hasAnyBreakdown, readEurekaFallbackTokens } from "../parsers/eureka-fallback.js";
import type { MarsRegistry } from "../parsers/mars.js";

export async function attributeOrchestrator(
  sessions: Session[],
  marsRegistry: MarsRegistry,
  eurekaIndex: EurekaIndex,
): Promise<{ attributed: Session[]; matchedEurekaCompositeKeys: Set<string> }> {
  const matchedEurekaCompositeKeys = new Set<string>();
  const attributed = await Promise.all(sessions.map(async (session) => {
    const eurekaEntry = eurekaIndex.lookup(session.id, session.projectPath);
    if (eurekaEntry) {
      matchedEurekaCompositeKeys.add(eurekaEntry.compositeKey);
      return applyEurekaMeta(await maybeUpgradeMatchedEurekaSession(session, eurekaEntry), eurekaEntry);
    }

    const marsMeta = resolveMarsMeta(session, marsRegistry);
    if (!marsMeta || session.source === "pi-agent") return session;
    return applyMarsMeta(session, marsMeta, session.source);
  }));
  return { attributed, matchedEurekaCompositeKeys };
}

export async function ingestEurekaOrphans(
  eurekaIndex: EurekaIndex,
  matchedCompositeKeys: Set<string>,
  machineId: string,
): Promise<Session[]> {
  const sessions: Session[] = [];
  for (const entry of eurekaIndex.byCompositeKey.values()) {
    if (matchedCompositeKeys.has(entry.compositeKey)) continue;
    const fallback = await readEurekaFallbackTokens(entry);
    const projectPath = entry.workingDirectory ?? entry.workspacePath ?? entry.sessionPath;
    const project = /\/\.(craft-agent|eureka)\/workspaces\//.test(projectPath.replace(/\\/g, "/"))
      ? "Eureka"
      : path.basename(normalizeProjectPath(projectPath)) || entry.workspaceId;
    const model = pickModel(entry, fallback ?? undefined);
    sessions.push({
      id: entry.eurekaSessionId,
      machineId,
      source: entry.underlyingSource,
      engine: eurekaEngineLabel(entry.underlyingSource, entry.runtimeProvider),
      projectPath,
      project,
      summary: entry.name ?? (entry.sessionType ? `${entry.sessionType} session` : undefined),
      model,
      createdAt: entry.firstTimestamp ?? new Date(0).toISOString(),
      modifiedAt: entry.lastTimestamp ?? entry.firstTimestamp ?? new Date(0).toISOString(),
      durationSeconds: computeActiveDurationSeconds(entry.eventTimestampsMs),
      turns: entry.userTurns ?? 0,
      messageCount: entry.messageCount ?? 0,
      toolCallCount: 0,
      tokens: fallback?.tokens ?? entry.telemetryTokens ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
      toolBreakdown: {},
      modelUsage: fallback && Object.keys(fallback.modelUsage).length > 0 ? fallback.modelUsage : undefined,
      usageEvents: fallback?.usageEvents,
      tokenProvenance: fallback?.provenance ?? (entry.telemetryTokens && hasAnyBreakdown(entry.telemetryTokens) ? entry.telemetryProvenance ?? "telemetry" : "none"),
      orchestrator: { kind: "eureka" },
    });
  }
  return sessions;
}

function applyEurekaMeta(session: Session, entry: EurekaIndexEntry): Session {
  const projectPath = entry.workingDirectory ?? entry.workspacePath ?? session.projectPath;
  const normalizedPath = normalizeProjectPath(projectPath);
  return {
    ...session,
    id: entry.eurekaSessionId,
    engine: eurekaEngineLabel(entry.underlyingSource, entry.runtimeProvider),
    projectPath,
    project: /\/\.(craft-agent|eureka)\/workspaces\//.test(projectPath.replace(/\\/g, "/")) ? "Eureka" : path.basename(normalizedPath) || session.project,
    summary: entry.name ?? session.summary,
    orchestrator: { kind: "eureka" },
  };
}

async function maybeUpgradeMatchedEurekaSession(session: Session, entry: EurekaIndexEntry): Promise<Session> {
  if (!shouldCheckMatchedFallback(session)) {
    return session;
  }

  const fallback = await readEurekaFallbackTokens(entry);
  if (!fallback || !fallbackHasUsefulTokens(fallback.tokens)) {
    return session;
  }

  const upgraded: Session = {
    ...session,
    tokens: fallback.tokens,
    model: pickModel(entry, fallback),
    modelUsage: Object.keys(fallback.modelUsage).length > 0 ? fallback.modelUsage : session.modelUsage,
    usageEvents: fallback.usageEvents ?? session.usageEvents,
    tokenProvenance: fallback.provenance,
    modifiedAt: entry.lastTimestamp ?? session.modifiedAt,
  };

  return preferSession(session, upgraded);
}

function shouldCheckMatchedFallback(session: Session): boolean {
  return session.tokenProvenance === "telemetry" || session.tokenProvenance === "none" || session.tokenProvenance === undefined;
}

function fallbackHasUsefulTokens(tokens: Session["tokens"]): boolean {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheCreation > 0 || tokens.cacheRead > 0;
}

function resolveMarsMeta(session: Session, marsRegistry: MarsRegistry) {
  if (session.source === "claude-code") return marsRegistry.byAgentSessionId.claudeCode.get(session.id);
  if (session.source === "codex") return marsRegistry.byAgentSessionId.codex.get(session.id);
  return marsRegistry.byAgentSessionId.copilotCli.get(session.id);
}

function pickModel(entry: EurekaIndexEntry, fallback?: { models: string[]; modelUsage: Record<string, { input: number; output: number; cacheCreation: number; cacheRead: number }> }): string {
  if (fallback?.modelUsage && Object.keys(fallback.modelUsage).length > 0) {
    return Object.entries(fallback.modelUsage)
      .sort(([, left], [, right]) => (right.input + right.output + right.cacheRead) - (left.input + left.output + left.cacheRead))[0][0];
  }
  if (fallback?.models && fallback.models.length > 0) {
    return fallback.models[0];
  }
  return entry.headerModel ?? "unknown";
}
