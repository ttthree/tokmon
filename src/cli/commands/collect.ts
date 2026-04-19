import { mergeCursorState } from "../../core/cursor.js";
import { updateSessions, loadMachineData, saveMachineData } from "../../core/data.js";
import { logDiag } from "../../core/diag-log.js";
import { getMachineId, getMachineName } from "../../core/machine.js";
import { loadConfig } from "../../core/config.js";
import { maybeRefreshPricing } from "../../core/pricing.js";
import { parsers } from "../../parsers/index.js";
import { marsRegistry } from "../../parsers/mars.js";
import type { Session } from "../../core/types.js";
import { enrichSession, enrichSessionsBatched } from "../../core/enrich.js";

export { enrichSession, enrichSessionsBatched } from "../../core/enrich.js";

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

  const beforeSnapshot = snapshotOrchestrators(machineData.sessions);
  void logDiag({
    event: "collect.start",
    machineId,
    reset: Boolean(options.reset),
    sessionCount: Object.keys(machineData.sessions).length,
    orchestratorDistribution: beforeSnapshot,
  });

  let sessions: Session[] = [];
  const cursorUpdates: Record<string, (typeof machineData._cursor.files)[string]> = {};
  const perSourceCounts: Record<string, number> = {};

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

      // Log post-enrichment cost summary so we can correlate dashboard cost shifts to actual values.
      const enrichedTotalCost = enriched.reduce((s, x) => s + (x.cost?.total ?? 0), 0);
      void logDiag({
        event: "enrich.summary",
        source: parser.source,
        sessionCount: enriched.length,
        totalCost: Math.round(enrichedTotalCost * 100) / 100,
        // Top 5 most expensive — usually where shifts originate.
        topByCost: enriched
          .map((s) => ({ id: s.id, cost: Math.round((s.cost?.total ?? 0) * 100) / 100, prov: s.tokenProvenance, tokens: { i: s.tokens.input, o: s.tokens.output, cr: s.tokens.cacheRead, cc: s.tokens.cacheCreation } }))
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 5),
      });
    }

    perSourceCounts[parser.source] = parsed.sessions.length;
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

  const afterSnapshot = snapshotOrchestrators(machineData.sessions);
  void logDiag({
    event: "collect.done",
    machineId,
    durationMs: Date.now() - startedAt,
    perSourceCounts,
    marsRegistry: {
      claudeCode: marsRegistry.byAgentSessionId.claudeCode.size,
      codex: marsRegistry.byAgentSessionId.codex.size,
      copilotCli: marsRegistry.byAgentSessionId.copilotCli.size,
    },
    orchestratorDistribution: afterSnapshot,
    orchestratorDelta: diffSnapshots(beforeSnapshot, afterSnapshot),
    totalSessions: Object.keys(machineData.sessions).length,
  });

  const result = {
    sessionCount: sessions.length,
    durationMs: Date.now() - startedAt,
  };
  emit({ phase: "complete", ...result });
  return result;
}

function snapshotOrchestrators(sessions: Record<string, Session>): Record<string, { count: number; cost: number }> {
  const out: Record<string, { count: number; cost: number }> = {};
  for (const s of Object.values(sessions)) {
    const key = s.orchestrator?.kind ?? "(none)";
    if (!out[key]) out[key] = { count: 0, cost: 0 };
    out[key].count++;
    out[key].cost += s.cost?.total ?? 0;
  }
  // Round costs to make logs readable.
  for (const k of Object.keys(out)) out[k].cost = Math.round(out[k].cost * 100) / 100;
  return out;
}

function diffSnapshots(
  before: Record<string, { count: number; cost: number }>,
  after: Record<string, { count: number; cost: number }>,
): Record<string, { count: number; cost: number }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const delta: Record<string, { count: number; cost: number }> = {};
  for (const k of keys) {
    const b = before[k] ?? { count: 0, cost: 0 };
    const a = after[k] ?? { count: 0, cost: 0 };
    const dc = a.count - b.count;
    const dcost = Math.round((a.cost - b.cost) * 100) / 100;
    if (dc !== 0 || dcost !== 0) delta[k] = { count: dc, cost: dcost };
  }
  return delta;
}
