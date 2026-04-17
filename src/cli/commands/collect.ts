import { mergeCursorState } from "../../core/cursor.js";
import { updateSessions, loadMachineData, saveMachineData } from "../../core/data.js";
import { getMachineId } from "../../core/machine.js";
import { loadConfig } from "../../core/config.js";
import { maybeRefreshPricing, calculateSessionCost } from "../../core/pricing.js";
import { resolveProject } from "../../core/project.js";
import { parsers } from "../../parsers/index.js";
import type { Session } from "../../core/types.js";

export interface CollectOptions {
  reset?: boolean;
  silent?: boolean;
}

export interface CollectResult {
  sessionCount: number;
  durationMs: number;
}

const SOURCE_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot CLI",
  eureka: "Eureka",
};

function clearLine(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[K");
  }
}

function writeProgress(source: string, detail: string, silent: boolean): void {
  if (silent || !process.stdout.isTTY) return;
  clearLine();
  const label = SOURCE_LABELS[source] ?? source;
  process.stdout.write(`  ⟳ ${label}: ${detail}`);
}

function writeSourceDone(source: string, count: number, ms: number, silent: boolean): void {
  if (silent) return;
  clearLine();
  const label = SOURCE_LABELS[source] ?? source;
  const time = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  console.log(`  ✓ ${label}: ${count} sessions (${time})`);
}

export async function collectCommand(options: CollectOptions = {}): Promise<CollectResult> {
  const startedAt = Date.now();
  const silent = options.silent ?? false;
  const machineId = await getMachineId();
  const config = await loadConfig();

  writeProgress("pricing", "refreshing pricing data…", silent);
  await maybeRefreshPricing(config.pricing.updateIntervalHours, config.pricing.autoUpdate);
  if (!silent) clearLine();

  const machineData = await loadMachineData(machineId);
  if (options.reset) {
    machineData._cursor = { version: 1, updatedAt: new Date(0).toISOString(), files: {} };
    machineData.sessions = {};
  }

  let sessions: Session[] = [];
  const cursorUpdates: Record<string, (typeof machineData._cursor.files)[string]> = {};

  for (const parser of parsers) {
    const sourceStart = Date.now();
    writeProgress(parser.source, "scanning…", silent);
    const parsed = await parser.parse({ machineId, existingCursor: machineData._cursor });

    if (parsed.sessions.length > 0) {
      writeProgress(parser.source, `enriching ${parsed.sessions.length} sessions…`, silent);
      const enriched = await enrichSessionsBatched(parsed.sessions, machineId, config, (done, total) => {
        writeProgress(parser.source, `enriching ${done}/${total}…`, silent);
      });
      sessions = sessions.concat(enriched);
    }

    Object.assign(cursorUpdates, parsed.cursorUpdates);
    writeSourceDone(parser.source, parsed.sessions.length, Date.now() - sourceStart, silent);
  }

  writeProgress("save", "writing data…", silent);
  machineData.sessions = updateSessions(machineData.sessions, sessions, machineId);
  machineData._cursor = mergeCursorState(machineData._cursor, cursorUpdates);
  await saveMachineData(machineData);
  if (!silent) clearLine();

  return {
    sessionCount: sessions.length,
    durationMs: Date.now() - startedAt,
  };
}

async function enrichSessionsBatched(
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

async function enrichSession(session: Session, machineId: string, config: Awaited<ReturnType<typeof loadConfig>>): Promise<Session> {
  const resolvedProject = await resolveProject(session.projectPath, config);
  const cost = await calculateSessionCost(new Date(session.createdAt), session.tokens, session.model, session.source);

  return {
    ...session,
    machineId,
    project: resolvedProject,
    cost,
  };
}
