import { attributeOrchestrator, ingestEurekaOrphans } from "../../core/attribute.js";
import { mergeCursorState } from "../../core/cursor.js";
import { updateSessions, loadMachineData, saveMachineData } from "../../core/data.js";
import { logDiag } from "../../core/diag-log.js";
import { enrichSession, enrichSessionsBatched } from "../../core/enrich.js";
import { loadConfig } from "../../core/config.js";
import { getMachineId, getMachineName } from "../../core/machine.js";
import { discoverParseRoots } from "../../core/parse-roots.js";
import { maybeRefreshPricing } from "../../core/pricing.js";
import type { Session } from "../../core/types.js";
import { sdkParsers } from "../../parsers/index.js";
import { buildEurekaIndex } from "../../parsers/eureka-index.js";
import { buildMarsRegistry } from "../../parsers/mars.js";

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

function writeSourceDone(source: string, count: number, ms: number, silent: boolean, detail = "sessions"): void {
  if (silent) return;
  clearLine();
  const label = SOURCE_LABELS[source] ?? source;
  const time = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  console.log(`  ✓ ${label}: ${count} ${detail} (${time})`);
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

  writeProgress("mars", "discovering parse roots…", silent);
  const parseRoots = await discoverParseRoots({ machineId, existingCursor: machineData._cursor, sources: config.sources });
  void logDiag({
    event: "collect.phase.parse-roots",
    claudeRoots: parseRoots.claudeRoots.length,
    codexRoots: parseRoots.codexRoots.length,
    copilotRoots: parseRoots.copilotRoots.length,
  });

  const rawSessions: Session[] = [];
  const cursorUpdates: Record<string, (typeof machineData._cursor.files)[string]> = {};
  const perSourceCounts: Record<string, number> = {};

  for (const parser of sdkParsers) {
    const sourceStart = Date.now();
    writeProgress(parser.source, "scanning…", silent);
    emit({ phase: "source-start", source: parser.source });
    const extraRoots = parser.source === "claude-code"
      ? parseRoots.claudeRoots
      : parser.source === "codex"
        ? parseRoots.codexRoots
        : parseRoots.copilotRoots;
    const parsed = await parser.parse({ machineId, existingCursor: machineData._cursor, sources: config.sources }, extraRoots);
    rawSessions.push(...parsed.sessions);
    perSourceCounts[parser.source] = parsed.sessions.length;
    Object.assign(cursorUpdates, parsed.cursorUpdates);
    writeSourceDone(parser.source, parsed.sessions.length, Date.now() - sourceStart, silent);
    emit({ phase: "source-done", source: parser.source, count: parsed.sessions.length, ms: Date.now() - sourceStart });
  }

  const marsStart = Date.now();
  writeProgress("mars", "loading registry…", silent);
  emit({ phase: "source-start", source: "mars" });
  const [marsRegistry, eurekaIndex] = await Promise.all([
    buildMarsRegistry({ machineId, existingCursor: machineData._cursor, sources: config.sources }),
    buildEurekaIndex({ machineId, existingCursor: machineData._cursor, sources: config.sources }),
  ]);
  const marsTagged =
    marsRegistry.byAgentSessionId.claudeCode.size +
    marsRegistry.byAgentSessionId.codex.size +
    marsRegistry.byAgentSessionId.copilotCli.size;
  writeSourceDone("mars", marsTagged, Date.now() - marsStart, silent, "tagged");
  emit({ phase: "source-done", source: "mars", count: marsTagged, ms: Date.now() - marsStart });
  void logDiag({
    event: "collect.phase.index",
    marsTagged,
    eurekaEntries: eurekaIndex.byCompositeKey.size,
  });

  const { attributed, matchedEurekaCompositeKeys } = await attributeOrchestrator(rawSessions, marsRegistry, eurekaIndex);
  const orphans = await ingestEurekaOrphans(eurekaIndex, matchedEurekaCompositeKeys, machineId);
  void logDiag({
    event: "collect.phase.attribute",
    rawSessionCount: rawSessions.length,
    attributedCount: attributed.length,
    matchedEurekaCount: matchedEurekaCompositeKeys.size,
    orphanCount: orphans.length,
  });

  const allSessions = attributed.concat(orphans);
  writeProgress("save", `enriching ${allSessions.length} sessions…`, silent);
  const enriched = await enrichSessionsBatched(allSessions, machineId, config, (done, total) => {
    writeProgress("save", `enriching ${done}/${total}…`, silent);
    emit({ phase: "source-progress", source: "save", detail: `enriching ${done}/${total}`, done, total });
  });

  for (const [source, sessions] of Object.entries(groupBySource(enriched))) {
    const enrichedTotalCost = sessions.reduce((sum, session) => sum + (session.cost?.total ?? 0), 0);
    void logDiag({
      event: "enrich.summary",
      source,
      sessionCount: sessions.length,
      totalCost: Math.round(enrichedTotalCost * 100) / 100,
      topByCost: sessions
        .map((session) => ({ id: session.id, cost: Math.round((session.cost?.total ?? 0) * 100) / 100, prov: session.tokenProvenance, tokens: { i: session.tokens.input, o: session.tokens.output, cr: session.tokens.cacheRead, cc: session.tokens.cacheCreation } }))
        .sort((left, right) => right.cost - left.cost)
        .slice(0, 5),
    });
  }

  writeProgress("save", "writing data…", silent);
  emit({ phase: "save", detail: "writing data" });
  machineData.sessions = updateSessions(machineData.sessions, enriched, machineId);
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
    sessionCount: enriched.length,
    durationMs: Date.now() - startedAt,
  };
  emit({ phase: "complete", ...result });
  return result;
}

function groupBySource(sessions: Session[]): Record<string, Session[]> {
  const grouped: Record<string, Session[]> = {};
  for (const session of sessions) {
    grouped[session.source] ??= [];
    grouped[session.source].push(session);
  }
  return grouped;
}

function snapshotOrchestrators(sessions: Record<string, Session>): Record<string, { count: number; cost: number }> {
  const out: Record<string, { count: number; cost: number }> = {};
  for (const s of Object.values(sessions)) {
    const key = s.orchestrator?.kind ?? "(none)";
    if (!out[key]) out[key] = { count: 0, cost: 0 };
    out[key].count++;
    out[key].cost += s.cost?.total ?? 0;
  }
  for (const key of Object.keys(out)) out[key].cost = Math.round(out[key].cost * 100) / 100;
  return out;
}

function diffSnapshots(
  before: Record<string, { count: number; cost: number }>,
  after: Record<string, { count: number; cost: number }>,
): Record<string, { count: number; cost: number }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const delta: Record<string, { count: number; cost: number }> = {};
  for (const key of keys) {
    const b = before[key] ?? { count: 0, cost: 0 };
    const a = after[key] ?? { count: 0, cost: 0 };
    const dc = a.count - b.count;
    const dcost = Math.round((a.cost - b.cost) * 100) / 100;
    if (dc !== 0 || dcost !== 0) delta[key] = { count: dc, cost: dcost };
  }
  return delta;
}
