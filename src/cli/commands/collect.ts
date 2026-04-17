import { mergeCursorState } from "../../core/cursor.js";
import { updateSessions, loadMachineData, saveMachineData } from "../../core/data.js";
import { getMachineId, getMachineName } from "../../core/machine.js";
import { loadConfig } from "../../core/config.js";
import { maybeRefreshPricing, calculateSessionCost } from "../../core/pricing.js";
import { resolveProject } from "../../core/project.js";
import { parsers } from "../../parsers/index.js";
import { marsRegistry } from "../../parsers/mars.js";
import type { Session } from "../../core/types.js";

export interface CollectOptions {
  reset?: boolean;
  silent?: boolean;
  onProgress?: (event: CollectProgressEvent) => void;
}

export type CollectProgressEvent =
  | { phase: "pricing"; detail: string }
  | { phase: "source-start"; source: string }
  | { phase: "source-progress"; source: string; detail: string; done?: number; total?: number }
  | { phase: "source-done"; source: string; count: number; ms: number }
  | { phase: "save"; detail: string }
  | { phase: "complete"; sessionCount: number; durationMs: number };

export interface CollectResult {
  sessionCount: number;
  durationMs: number;
}

const SOURCE_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot CLI",
  eureka: "Eureka",
  mars: "Mars",
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
  if (source === "mars") {
    const tagged =
      marsRegistry.byAgentSessionId.claudeCode.size +
      marsRegistry.byAgentSessionId.codex.size +
      marsRegistry.byAgentSessionId.copilotCli.size;
    console.log(`  ✓ ${label}: registry loaded (${tagged} tagged) (${time})`);
    return;
  }
  console.log(`  ✓ ${label}: ${count} sessions (${time})`);
}

export async function collectCommand(options: CollectOptions = {}): Promise<CollectResult> {
  const startedAt = Date.now();
  const silent = options.silent ?? false;
  const emit = options.onProgress ?? (() => {});
  const machineId = await getMachineId();
  const config = await loadConfig();

  writeProgress("pricing", "refreshing pricing data…", silent);
  emit({ phase: "pricing", detail: "refreshing pricing data" });
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
    emit({ phase: "source-start", source: parser.source });
    const parsed = await parser.parse({ machineId, existingCursor: machineData._cursor, sources: config.sources });

    if (parsed.sessions.length > 0) {
      writeProgress(parser.source, `enriching ${parsed.sessions.length} sessions…`, silent);
      const enriched = await enrichSessionsBatched(parsed.sessions, machineId, config, (done, total) => {
        writeProgress(parser.source, `enriching ${done}/${total}…`, silent);
        emit({ phase: "source-progress", source: parser.source, detail: `enriching ${done}/${total}`, done, total });
      });
      sessions = sessions.concat(enriched);
    }

    Object.assign(cursorUpdates, parsed.cursorUpdates);
    writeSourceDone(parser.source, parsed.sessions.length, Date.now() - sourceStart, silent);
    emit({ phase: "source-done", source: parser.source, count: parsed.sessions.length, ms: Date.now() - sourceStart });
  }

  writeProgress("save", "writing data…", silent);
  emit({ phase: "save", detail: "writing data" });
  machineData.sessions = updateSessions(machineData.sessions, sessions, machineId);
  machineData._cursor = mergeCursorState(machineData._cursor, cursorUpdates);
  await saveMachineData(machineData, await getMachineName());
  if (!silent) clearLine();

  const result = {
    sessionCount: sessions.length,
    durationMs: Date.now() - startedAt,
  };
  emit({ phase: "complete", ...result });
  return result;
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
