import { createEmptyCursorState } from "../../../core/cursor.js";
import { loadConfig, detectAvailableSources } from "../../../core/config.js";
import { enrichSession } from "../../../core/enrich.js";
import { parsers } from "../../../parsers/index.js";
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
  const sessions: Session[] = [];

  for (const parser of parsers) {
    const parsed = await parser.parse({ machineId, existingCursor, sources });
    if (parsed.sessions.length === 0) continue;
    const enriched = await Promise.all(parsed.sessions.map((s) => enrichSession(s, machineId, config)));
    sessions.push(...enriched);
  }

  return sessions;
}
