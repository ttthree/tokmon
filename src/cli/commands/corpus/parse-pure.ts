import { attributeOrchestrator, ingestEurekaOrphans } from "../../../core/attribute.js";
import { createEmptyCursorState } from "../../../core/cursor.js";
import { mergeSession } from "../../../core/data.js";
import { loadConfig, detectAvailableSources } from "../../../core/config.js";
import { discoverParseRoots } from "../../../core/parse-roots.js";
import { enrichSession } from "../../../core/enrich.js";
import { buildEurekaIndex } from "../../../parsers/eureka-index.js";
import { sdkParsers } from "../../../parsers/index.js";
import { buildMarsRegistry } from "../../../parsers/mars.js";
import type { Session } from "../../../core/types.js";

export interface ParseAllPureOptions {
  forceAllSources?: boolean;
}

export async function parseAllPure(options: ParseAllPureOptions = {}): Promise<Session[]> {
  const config = await loadConfig();
  const sources = options.forceAllSources
    ? (await detectAvailableSources()).map((entry) => ({ ...entry, enabled: true }))
    : config.sources;

  const machineId = "machine";
  const existingCursor = createEmptyCursorState();
  const parseRoots = await discoverParseRoots({ machineId, existingCursor, sources });
  const rawSessions: Session[] = [];

  for (const parser of sdkParsers) {
    const extraRoots = parser.source === "claude-code"
      ? parseRoots.claudeRoots
      : parser.source === "codex"
        ? parseRoots.codexRoots
        : parseRoots.copilotRoots;
    const parsed = await parser.parse({ machineId, existingCursor, sources }, extraRoots);
    rawSessions.push(...parsed.sessions);
  }

  const [marsRegistry, eurekaIndex] = await Promise.all([
    buildMarsRegistry({ machineId, existingCursor, sources }),
    buildEurekaIndex({ machineId, existingCursor, sources }),
  ]);
  const { attributed, matchedEurekaCompositeKeys } = await attributeOrchestrator(rawSessions, marsRegistry, eurekaIndex);
  const orphans = await ingestEurekaOrphans(eurekaIndex, matchedEurekaCompositeKeys, machineId);
  const sessions = await Promise.all(attributed.concat(orphans).map((session) => enrichSession(session, machineId, config)));

  // Dedupe by `${source}:${id}` to mirror how `collect` writes into the keyed
  // `machineData.sessions` map. Without this, sessions surfaced by two
  // overlapping source paths (e.g. legacy `.craft-agent/workspaces` and new
  // `.eureka/workspaces` both containing the same workspace) get counted twice
  // in the golden but only once at runtime — making e2e totals drift.
  const deduped = new Map<string, Session>();
  for (const session of sessions) {
    const key = `${session.source}:${session.id}`;
    deduped.set(key, mergeSession(deduped.get(key), session));
  }
  return [...deduped.values()];
}
