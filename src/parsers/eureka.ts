import fs from "node:fs/promises";
import path from "node:path";

import { getCraftAgentClaudeDirectory, getHomeDirectory } from "../core/config.js";
import { logDiag } from "../core/diag-log.js";
import { computeActiveDurationSeconds } from "../core/duration.js";
import { inferUnderlyingSource } from "../core/orchestrator.js";
import { normalizeProjectPath } from "../core/project.js";
import { encodeClaudeProjectPath } from "../core/source-resolver.js";
import { streamJsonl } from "./util/jsonl-stream.js";
import type { FileCursor, ParseResult, Parser, ParserContext, Session, Source, TokenBreakdown, TokenProvenance } from "../core/types.js";

// Set of CC session IDs claimed by Eureka (populated during parse, read by CC parser)
export const claimedCcSessionIds = new Set<string>();

interface LlmTelemetryEntry {
  kind: "llm_telemetry";
  timestamp: string;
  taskId: string;
  turnId: string;
  callId: string;
  sessionType: string;
  runtimeProvider: string;
  provider: string;
  model: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  requestBodyBytes?: number;
  messageCount?: number;
  toolCount?: number;
  systemBytes?: number;
  messageBytes?: number;
  toolSchemaBytes?: number;
  toolResultBytes?: number;
  base64Bytes?: number;
  workspaceRootPath?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

// Session header entry in session.jsonl (first line)
interface SessionHeaderEntry {
  id: string;
  workspaceRootPath?: string;
  createdAt?: number;
  lastUsedAt?: number;
  name?: string;
  model?: string;
  engine?: string;
  runtimeProvider?: string;
  type?: string;
  messageCount?: number;
  userMessageCount?: number;
  workingDirectory?: string;
  sdkSessionId?: string;
  sdkCwd?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

interface SessionMeta {
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTimestampsMs: number[];
  turns: Set<string>;
  calls: number;
  models: Set<string>;
  providers: Set<string>;
  tokens: TokenBreakdown;
  sdkSessionId?: string;
  sdkCwd?: string;
  engine?: string;
  runtimeProvider?: string;
  headerModel?: string;
  modelUsage?: Record<string, TokenBreakdown>;
  tokenProvenance?: TokenProvenance;
  toolBreakdown: Record<string, number>;
  workspacePath?: string;
  workingDirectory?: string;
  sessionType?: string;
  name?: string;
  messageCount?: number;
  userTurns?: number;
}

export const eurekaParser: Parser = {
  source: "eureka",
  async parse(context: ParserContext): Promise<ParseResult> {
    claimedCcSessionIds.clear();
    const sessions: Session[] = [];
    const cursorUpdates: Record<string, FileCursor> = {};

    // Eureka stores sessions in ~/.craft-agent/workspaces/{workspace-id}/sessions/{session-id}/
    const enabledEureka = (context.sources ?? [])
      .filter((s) => s.enabled && s.type === "eureka")
      .map((s) => s.path);
    const workspacesDirs =
      enabledEureka.length > 0
        ? enabledEureka
        : [
            path.join(getHomeDirectory(), ".craft-agent", "workspaces"),
            path.join(getHomeDirectory(), ".eureka", "workspaces"),
          ];

    for (const workspacesDir of workspacesDirs) {
      const stat = await safeStat(workspacesDir);
      if (!stat?.isDirectory()) continue;

      // Iterate through workspaces
      const workspaces = await fs.readdir(workspacesDir, { withFileTypes: true }).catch(() => []);
      for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const sessionsDir = path.join(workspacesDir, workspace.name, "sessions");
      const sessionsDirStat = await safeStat(sessionsDir);
      if (!sessionsDirStat?.isDirectory()) continue;

      // Iterate through sessions
      const sessionDirs = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;
        const sessionPath = path.join(sessionsDir, sessionDir.name);

        // Prefer llm-telemetry.jsonl, fallback to session.jsonl
        const telemetryPath = path.join(sessionPath, "llm-telemetry.jsonl");
        const sessionJsonlPath = path.join(sessionPath, "session.jsonl");

        const telemetryStat = await safeStat(telemetryPath);
        const sessionJsonlStat = await safeStat(sessionJsonlPath);

        // Use telemetry file if exists, otherwise use session.jsonl
        const primaryFile = telemetryStat?.isFile() ? telemetryPath : sessionJsonlPath;
        const primaryStat = telemetryStat?.isFile() ? telemetryStat : sessionJsonlStat;

        if (!primaryStat?.isFile()) continue;

        // Check cursor for incremental processing.
        // Invalidate cursor if previous parse left tokens incomplete (CC .jsonl wasn't ready yet) so we retry.
        const cursor = context.existingCursor.files[primaryFile] ?? null;
        const sessionMtimeMs = await getEurekaSessionMtime(sessionPath, cursor?.claimedSdkSessionId, cursor?.claimedSdkCwd);
        // Legacy cursor (pre-claim mechanism) has no lastProvenance recorded at all.
        // Force re-parse so claimedSdkSessionId gets populated; otherwise the CC parser
        // walks the same SDK .jsonl file and double-counts cost on every collect.
        const legacyCursor = cursor !== null && cursor.lastProvenance === undefined;
        const legacyIncompleteSdkCursor = Boolean(cursor?.claimedSdkSessionId) && (!cursor?.lastProvenance || !cursor?.claimedSdkCwd);
        const cursorIsStale =
          legacyCursor ||
          (Boolean(cursor?.claimedSdkSessionId) &&
            (cursor?.lastProvenance === "telemetry-incomplete" || legacyIncompleteSdkCursor));
        if (
          cursor &&
          !cursorIsStale &&
          cursor.inode === Number(primaryStat.ino) &&
          cursor.size === primaryStat.size &&
          cursor.mtimeMs === sessionMtimeMs
        ) {
          // Re-register the SDK session claim so the CC parser still skips this file.
          // Without this, incremental runs leave claimedCcSessionIds empty and CC double-counts SDK sessions.
          if (cursor.claimedSdkSessionId) {
            claimedCcSessionIds.add(cursor.claimedSdkSessionId);
          }
          // Carry the existing cursor entry forward so the persisted cursor never loses claim info.
          cursorUpdates[primaryFile] = cursor;
          continue; // Already processed and unchanged
        }

        const result = await parseEurekaSession(
          sessionDir.name,
          sessionPath,
          telemetryStat?.isFile() ? telemetryPath : null,
          sessionJsonlStat?.isFile() ? sessionJsonlPath : null,
          workspace.name,
          context.machineId,
        );

        if (result) {
          sessions.push(result.session);
          void logDiag({
            event: "eureka.session.write",
            sessionId: result.session.id,
            source: result.session.source,
            orchestratorKind: result.session.orchestrator?.kind ?? null,
            tokenProvenance: result.session.tokenProvenance,
            sdkSessionId: result.sdkSessionId ?? null,
            cursorWasStale: cursor ? Boolean((cursor.lastProvenance === undefined) || (cursor.lastProvenance === "telemetry-incomplete") || (cursor.claimedSdkSessionId && (!cursor.lastProvenance || !cursor.claimedSdkCwd))) : null,
            cost: result.session.cost?.total ?? 0,
          });
          // Recompute mtime AFTER the parse — this captures the CC SDK .jsonl mtime that we
          // may have just learned about (via the parsed sdkCwd), so we don't immediately
          // re-parse on the next collect when the SDK file grew during this run.
          const finalMtimeMs = await getEurekaSessionMtime(sessionPath, result.sdkSessionId, result.sdkCwd);
          cursorUpdates[primaryFile] = {
            path: primaryFile,
            inode: Number(primaryStat.ino),
            size: Number(primaryStat.size),
            mtimeMs: finalMtimeMs,
            byteOffset: Number(primaryStat.size),
            processedAt: new Date().toISOString(),
            claimedSdkSessionId: result.sdkSessionId,
            claimedSdkCwd: result.sdkCwd,
            lastProvenance: result.session.tokenProvenance,
          };
        }
      }
    }
    }

    return { sessions, cursorUpdates };
  },
};

async function parseEurekaSession(
  sessionId: string,
  sessionPath: string,
  telemetryPath: string | null,
  sessionJsonlPath: string | null,
  workspaceId: string,
  machineId: string,
): Promise<{ session: Session; sdkSessionId?: string; sdkCwd?: string } | null> {
  const meta: SessionMeta = {
    eventTimestampsMs: [],
    turns: new Set(),
    calls: 0,
    models: new Set(),
    providers: new Set(),
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    toolBreakdown: {},
  };

  // First try to get session header info from session.jsonl
  if (sessionJsonlPath) {
    const sessionRaw = await fs.readFile(sessionJsonlPath, "utf8").catch(() => "");
    const firstLine = sessionRaw.split(/\r?\n/)[0];
    if (firstLine) {
      const header = parseJsonLine<SessionHeaderEntry>(firstLine);
      if (header && header.id) {
        meta.name = header.name;
        meta.sessionType = header.type;
        meta.headerModel = typeof header.model === "string" ? header.model : undefined;
        meta.workspacePath = header.workspaceRootPath?.replace(/^~/, getHomeDirectory());
        meta.workingDirectory = header.workingDirectory?.replace(/^~/, getHomeDirectory());
        meta.messageCount = header.messageCount;
        meta.userTurns = header.userMessageCount;

        // Get timestamps from header
        if (header.createdAt) {
          meta.firstTimestamp = new Date(header.createdAt).toISOString();
        }
        if (header.lastUsedAt) {
          meta.lastTimestamp = new Date(header.lastUsedAt).toISOString();
        }

        // SDK session mapping — the key to getting precise token data
        if (header.sdkSessionId) {
          meta.sdkSessionId = header.sdkSessionId;
          meta.sdkCwd = header.sdkCwd?.replace(/^~/, getHomeDirectory());
        }

        // Track engine as fallback model (only used if telemetry has no specific models)
        if (header.engine) {
          meta.engine = header.engine;
        }
        if (header.runtimeProvider) {
          meta.runtimeProvider = header.runtimeProvider;
          meta.providers.add(header.runtimeProvider);
        }
      }
    }
  }

  // Parse llm-telemetry.jsonl for timestamps, turns, duration, models, and
  // NON-Anthropic token data. For Anthropic sessions, token data comes from the
  // session header (which has accurate cache breakdown). For Codex/OpenAI sessions,
  // per-call telemetry data is the only source.
  if (telemetryPath) {
    const raw = await fs.readFile(telemetryPath, "utf8").catch(() => "");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = parseJsonLine<LlmTelemetryEntry>(line);
      if (!entry || entry.kind !== "llm_telemetry") continue;

      // Track timestamps (telemetry is more precise)
      if (!meta.firstTimestamp || entry.timestamp < meta.firstTimestamp) {
        meta.firstTimestamp = entry.timestamp;
      }
      if (!meta.lastTimestamp || entry.timestamp > meta.lastTimestamp) {
        meta.lastTimestamp = entry.timestamp;
      }

      // Capture per-event timestamp for active-duration calculation.
      const ms = Date.parse(entry.timestamp);
      if (Number.isFinite(ms)) meta.eventTimestampsMs.push(ms);

      // Track turns and calls
      if (entry.turnId) meta.turns.add(entry.turnId);
      meta.calls += 1;

      // Track providers (models come from session files, not telemetry)
      if (entry.provider) meta.providers.add(entry.provider);

      // Track tokens ONLY for non-Anthropic providers (codex, openai, etc).
      // Anthropic tokens are owned by the CC parser which has precise cache breakdown.
      if (entry.provider && entry.provider !== "anthropic") {
        const cacheRead = entry.cacheReadTokens ?? 0;
        const cacheCreation = entry.cacheCreationTokens ?? 0;
        // inputTokens from telemetry is INCLUSIVE of cache (like OpenAI's prompt_tokens).
        // Subtract cacheRead to get net new input, matching tokmon's convention.
        meta.tokens.input += Math.max(0, (entry.inputTokens ?? 0) - cacheRead);
        meta.tokens.output += entry.outputTokens ?? 0;
        meta.tokens.cacheRead += cacheRead;
        meta.tokens.cacheCreation += cacheCreation;
      }

      // Track workspace path from telemetry
      if (entry.workspaceRootPath && !meta.workspacePath) {
        meta.workspacePath = entry.workspaceRootPath;
      }

      // Track session type from telemetry
      if (entry.sessionType && !meta.sessionType) {
        meta.sessionType = entry.sessionType;
      }
    }
  }

  // Read precise token data + model info from the underlying SDK session files.
  let underlyingSource: Source;
  if (meta.sdkSessionId) {
    const runtimeProvider = (meta.runtimeProvider ?? "").toLowerCase();
    const engine = (meta.engine ?? "").toLowerCase();

    if (runtimeProvider.includes("copilot")) {
      underlyingSource = "copilot-cli";
      const result = await readSdkSessionTokens(sessionPath, meta.sdkSessionId, meta.headerModel);
      if (result) {
        meta.tokens = result.tokens;
        meta.modelUsage = result.modelUsage;
        meta.tokenProvenance = result.provenance;
        for (const modelId of result.models) meta.models.add(modelId);
      } else {
        meta.tokenProvenance = "telemetry-incomplete";
      }
    } else if (engine.includes("codex") || runtimeProvider.includes("codex")) {
      underlyingSource = "codex";
      const result = await readSdkSessionTokens(sessionPath, meta.sdkSessionId, meta.headerModel);
      if (result) {
        meta.tokens = result.tokens;
        meta.modelUsage = result.modelUsage;
        meta.tokenProvenance = result.provenance;
        for (const modelId of result.models) meta.models.add(modelId);
      } else {
        meta.tokenProvenance = telemetryProvenance(meta.tokens, "telemetry");
      }
    } else {
      underlyingSource = "claude-code";
      const result = await readCcSessionTokens(meta.sdkSessionId, meta.sdkCwd);
      if (result) {
        meta.tokens = result.tokens;
        meta.modelUsage = result.modelUsage;
        meta.tokenProvenance = result.provenance;
        for (const modelId of result.models) meta.models.add(modelId);
      } else {
        meta.tokenProvenance = "telemetry-incomplete";
      }
    }

    claimedCcSessionIds.add(meta.sdkSessionId);
  } else {
    underlyingSource = inferUnderlyingSource(meta.runtimeProvider, meta.engine);
    meta.tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    meta.modelUsage = undefined;
    meta.models.clear();
    meta.tokenProvenance = "none";
  }

  // Need at least some data to create a session
  if (!meta.firstTimestamp && !meta.lastTimestamp) {
    return null;
  }

  const createdAt = meta.firstTimestamp ?? new Date(0).toISOString();
  const modifiedAt = meta.lastTimestamp ?? createdAt;
  const durationSeconds = computeActiveDurationSeconds(meta.eventTimestampsMs);

  // Build model string — use specific models from session files, fallback to engine
  const modelList = Array.from(meta.models);
  // Pick the primary model — the one with most tokens in modelUsage, or first found
  let model = "unknown";
  if (meta.modelUsage && Object.keys(meta.modelUsage).length > 0) {
    model = Object.entries(meta.modelUsage)
      .sort(([, a], [, b]) => (b.input + b.output + b.cacheRead) - (a.input + a.output + a.cacheRead))[0][0];
  } else if (modelList.length > 0) {
    model = modelList[0];
  } else if (meta.headerModel) {
    model = meta.headerModel;
  }

  // Project path: prefer workingDirectory (actual user project), fallback to workspace path
  const projectPath = meta.workingDirectory ?? meta.workspacePath ?? sessionPath;

  // If projectPath is a .craft-agent/workspaces UUID path, label as "Eureka" instead of UUID
  const isWorkspacePath = /\/\.(craft-agent|eureka)\/workspaces\//.test(projectPath.replace(/\\/g, "/"));
  const project = isWorkspacePath
    ? "Eureka"
    : path.basename(normalizeProjectPath(projectPath)) || workspaceId;

  const session: Session = {
    id: sessionId,
    machineId,
    source: underlyingSource,
    engine: formatEurekaEngine(meta.engine, meta.providers),
    projectPath,
    project,
    summary: meta.name ?? (meta.sessionType ? `${meta.sessionType} session` : undefined),
    model,
    createdAt,
    modifiedAt,
    durationSeconds,
    turns: meta.userTurns ?? meta.turns.size,
    messageCount: meta.messageCount ?? meta.calls,
    toolCallCount: 0, // Would need to parse session.jsonl tool calls
    tokens: meta.tokens,
    // Cost is always calculated from tokens × pricing during enrichment.
    // Never use header costUsd — it can differ from our pricing data.
    cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    toolBreakdown: meta.toolBreakdown,
    modelUsage: meta.modelUsage && Object.keys(meta.modelUsage).length > 0 ? meta.modelUsage : undefined,
    tokenProvenance: meta.tokenProvenance,
    orchestrator: { kind: "eureka" },
  };
  return { session, sdkSessionId: meta.sdkSessionId, sdkCwd: meta.sdkCwd };
}

interface SdkTokenResult {
  tokens: TokenBreakdown;
  models: string[];
  modelUsage: Record<string, TokenBreakdown>;
  provenance: TokenProvenance;
}

/**
 * Read tokens + models from a Claude Code .jsonl file identified by sdkSessionId.
 */
async function readCcSessionTokens(sdkSessionId: string, sdkCwd?: string): Promise<SdkTokenResult | null> {
  if (!sdkCwd) return null;
  // Use the same encoding as Claude Code's on-disk projects directory so this
  // works on Windows (backslashes, drive-letter colons) too. The function is
  // total for non-empty input — no fallback needed.
  const encodedCwd = encodeClaudeProjectPath(sdkCwd);
  if (!encodedCwd) return null;
  const ccDir = path.join(getCraftAgentClaudeDirectory(), "projects", encodedCwd);
  const mainFile = path.join(ccDir, `${sdkSessionId}.jsonl`);

  const tokens: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const models = new Set<string>();
  const modelUsage: Record<string, TokenBreakdown> = {};
  let found = false;

  if (await accumulateCcJsonl(mainFile, tokens, models, modelUsage)) {
    found = true;
  }

  const subDir = path.join(ccDir, sdkSessionId, "subagents");
  try {
    const subs = await fs.readdir(subDir);
    for (const sub of subs) {
      if (!sub.endsWith(".jsonl")) continue;
      if (await accumulateCcJsonl(path.join(subDir, sub), tokens, models, modelUsage)) {
        found = true;
      }
    }
  } catch { /* no sub-agents */ }

  return found ? { tokens, models: [...models], modelUsage, provenance: "sdk-cc-jsonl" } : null;
}

/**
 * Read tokens from a Copilot or Codex SDK session file in the Eureka session directory.
 */
async function readSdkSessionTokens(sessionPath: string, sdkSessionId: string, fallbackModel?: string): Promise<SdkTokenResult | null> {
  const copilotEventsPath = path.join(sessionPath, ".copilot-sdk", "session-state", sdkSessionId, "events.jsonl");
  const copilotResult = await readCopilotSdkSessionTokens(copilotEventsPath, fallbackModel);
  if (copilotResult) {
    return copilotResult;
  }

  const codexHome = path.join(sessionPath, ".codex-home", "sessions");
  try {
    const files = await walkDir(codexHome, ".jsonl");
    for (const file of files) {
      if (!path.basename(file).includes(sdkSessionId)) continue;
      const result = await extractCodexTurnModelUsage(file, fallbackModel);
      if (result) {
        return result;
      }
    }
  } catch { /* codex-home doesn't exist */ }
  return null;
}

interface CodexRolloutEvent {
  type?: string;
  payload?: {
    model?: unknown;
    info?: {
      total_token_usage?: CodexTokenUsage;
    };
  };
}

interface CopilotSdkEvent {
  type?: string;
  data?: {
    usage?: CopilotSdkUsage;
    modelMetrics?: CopilotModelMetrics;
  };
}

interface CopilotSdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

type CopilotModelMetrics = Record<string, { usage?: CopilotSdkUsage }>;

async function extractCodexTurnModelUsage(filePath: string, fallbackModel?: string): Promise<SdkTokenResult | null> {
  const tokens: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const models = new Set<string>();
  const modelUsage: Record<string, TokenBreakdown> = {};
  let currentModel = fallbackModel;
  let previousUsage: CodexTokenUsage | null = null;
  let foundUsage = false;

  const stats = await streamJsonl(filePath, (obj) => {
    if (!obj || typeof obj !== "object") return;
    const parsed = obj as CodexRolloutEvent;

    if (parsed.type === "turn_context") {
      const turnModel = typeof parsed.payload?.model === "string" ? parsed.payload.model : undefined;
      if (turnModel) {
        currentModel = turnModel;
        models.add(turnModel);
      }
      return;
    }

    const totalUsage = parsed.payload?.info?.total_token_usage;
    if (!totalUsage || typeof totalUsage.input_tokens !== "number") return;

    const delta = previousUsage
      ? diffCodexUsage(totalUsage, previousUsage)
      : {
          input_tokens: numberOrZero(totalUsage.input_tokens),
          cached_input_tokens: numberOrZero(totalUsage.cached_input_tokens),
          output_tokens: numberOrZero(totalUsage.output_tokens),
        };
    previousUsage = totalUsage;
    if (!delta) return;

    foundUsage = true;
    const currentTokens = codexUsageToBreakdown(delta);
    addBreakdown(tokens, currentTokens);

    const attributionModel = currentModel ?? fallbackModel;
    if (!attributionModel) return;
    models.add(attributionModel);
    const usage = modelUsage[attributionModel] ?? (modelUsage[attributionModel] = emptyBreakdown());
    addBreakdown(usage, currentTokens);
  });

  if (!stats) {
    return null;
  }

  if (!foundUsage) {
    return null;
  }

  if (models.size === 0 && fallbackModel) {
    models.add(fallbackModel);
    modelUsage[fallbackModel] = { ...tokens };
  }

  return { tokens, models: [...models], modelUsage, provenance: "sdk-codex-rollout" };
}

async function readCopilotSdkSessionTokens(eventsPath: string, fallbackModel?: string): Promise<SdkTokenResult | null> {
  const aggregate = emptyBreakdown();
  const modelUsage: Record<string, TokenBreakdown> = {};
  let lastShutdown: SdkTokenResult | null = null;
  const turnEndUsage = emptyBreakdown();
  const messageUsage = emptyBreakdown();
  const otherUsage = emptyBreakdown();
  let sawTurnEndUsage = false;
  let sawEventUsage = false;

  const stats = await streamJsonl(eventsPath, (obj) => {
    if (!obj || typeof obj !== "object") return;
    const event = obj as CopilotSdkEvent;
    if (event.type === "session.shutdown") {
      const shutdownResult = shutdownMetricsToResult(event.data?.modelMetrics);
      if (shutdownResult) {
        lastShutdown = shutdownResult;
      }
      return;
    }

    const usage = copilotUsageToBreakdown(event.data?.usage);
    if (!hasAnyBreakdown(usage)) return;

    sawEventUsage = true;
    if (event.type === "assistant.turn_end") {
      sawTurnEndUsage = true;
      addBreakdown(turnEndUsage, usage);
    } else if (event.type === "assistant.message") {
      addBreakdown(messageUsage, usage);
    } else {
      addBreakdown(otherUsage, usage);
    }
  });

  if (!stats) {
    return null;
  }
  if (lastShutdown) {
    return lastShutdown;
  }
  if (!sawEventUsage) {
    return null;
  }

  addBreakdown(aggregate, otherUsage);
  addBreakdown(aggregate, sawTurnEndUsage ? turnEndUsage : messageUsage);

  const models = fallbackModel ? [fallbackModel] : [];
  if (fallbackModel) {
    modelUsage[fallbackModel] = { ...aggregate };
  }

  return { tokens: aggregate, modelUsage, models, provenance: "sdk-events" };
}

function diffCodexUsage(current: CodexTokenUsage, previous: CodexTokenUsage): CodexTokenUsage | null {
  const input_tokens = numberOrZero(current.input_tokens) - numberOrZero(previous.input_tokens);
  const cached_input_tokens = numberOrZero(current.cached_input_tokens) - numberOrZero(previous.cached_input_tokens);
  const output_tokens = numberOrZero(current.output_tokens) - numberOrZero(previous.output_tokens);

  if (input_tokens < 0 || cached_input_tokens < 0 || output_tokens < 0) {
    return null;
  }

  if (input_tokens === 0 && cached_input_tokens === 0 && output_tokens === 0) {
    return null;
  }

  return { input_tokens, cached_input_tokens, output_tokens };
}

function codexUsageToBreakdown(usage: CodexTokenUsage): TokenBreakdown {
  const totalInput = numberOrZero(usage.input_tokens);
  const cacheRead = numberOrZero(usage.cached_input_tokens);
  return {
    input: Math.max(0, totalInput - cacheRead),
    output: numberOrZero(usage.output_tokens),
    cacheCreation: 0,
    cacheRead,
  };
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface CcUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

async function walkDir(dir: string, ext: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...await walkDir(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) results.push(full);
    }
  } catch { /* dir doesn't exist */ }
  return results;
}

async function accumulateCcJsonl(
  filePath: string,
  tokens: TokenBreakdown,
  models: Set<string>,
  modelUsage: Record<string, TokenBreakdown>,
): Promise<boolean> {
  let found = false;
  const stats = await streamJsonl(filePath, (obj) => {
    if (!obj || typeof obj !== "object") return;
    const envelope = obj as { type?: string; model?: string; usage?: CcUsage; message?: { model?: string; usage?: CcUsage } };
    if (envelope.type !== "assistant") return;

    const model = stringOrUndefined(envelope.message?.model ?? envelope.model);
    if (model && !model.startsWith("<")) {
      models.add(model);
    }

    const usage = ccUsageToBreakdown(envelope.message?.usage ?? envelope.usage);
    if (!hasAnyBreakdown(usage)) return;

    found = true;
    addBreakdown(tokens, usage);
    if (!model) return;
    const bucket = modelUsage[model] ?? (modelUsage[model] = emptyBreakdown());
    addBreakdown(bucket, usage);
  });

  return Boolean(stats && found);
}

function shutdownMetricsToResult(metrics: CopilotModelMetrics | undefined): SdkTokenResult | null {
  if (!metrics || typeof metrics !== "object") return null;

  const tokens = emptyBreakdown();
  const modelUsage: Record<string, TokenBreakdown> = {};
  const models = (Object.entries(metrics) as Array<[string, { usage?: CopilotSdkUsage }]> )
    .map(([modelId, metric]) => [modelId, copilotUsageToBreakdown(metric.usage)] as const)
    .filter(([, usage]) => hasAnyBreakdown(usage))
    .sort(([left], [right]) => left.localeCompare(right));

  if (models.length === 0) return null;

  for (const [modelId, usage] of models) {
    addBreakdown(tokens, usage);
    modelUsage[modelId] = { ...usage };
  }

  return { tokens, modelUsage, models: models.map(([modelId]) => modelId), provenance: "sdk-shutdown" };
}

function ccUsageToBreakdown(usage: CcUsage | undefined): TokenBreakdown {
  return {
    input: numberOrZero(usage?.input_tokens),
    output: numberOrZero(usage?.output_tokens),
    cacheCreation: numberOrZero(usage?.cache_creation_input_tokens),
    cacheRead: numberOrZero(usage?.cache_read_input_tokens),
  };
}

function copilotUsageToBreakdown(usage: CopilotSdkUsage | undefined): TokenBreakdown {
  const cacheRead = numberOrZero(usage?.cacheReadTokens);
  return {
    input: Math.max(0, numberOrZero(usage?.inputTokens) - cacheRead),
    output: numberOrZero(usage?.outputTokens),
    cacheCreation: numberOrZero(usage?.cacheWriteTokens),
    cacheRead,
  };
}

function emptyBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function addBreakdown(target: TokenBreakdown, delta: TokenBreakdown): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheCreation += delta.cacheCreation;
  target.cacheRead += delta.cacheRead;
}

function hasAnyBreakdown(tokens: TokenBreakdown): boolean {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheCreation > 0 || tokens.cacheRead > 0;
}

function telemetryProvenance(tokens: TokenBreakdown, provenance: TokenProvenance): TokenProvenance | undefined {
  return hasAnyBreakdown(tokens) ? provenance : undefined;
}

async function getEurekaSessionMtime(sessionPath: string, sdkSessionId?: string, sdkCwd?: string): Promise<number> {
  const candidates = [
    path.join(sessionPath, "session.jsonl"),
    path.join(sessionPath, "llm-telemetry.jsonl"),
  ];
  if (sdkSessionId) {
    candidates.push(path.join(sessionPath, ".copilot-sdk", "session-state", sdkSessionId, "events.jsonl"));
  }
  // Include the CC SDK .jsonl so cursor invalidates when CC writes after our first parse.
  // CC files live outside sessionPath in ~/.craft-agent/.claude/projects/<encoded-cwd>/<sdkSessionId>.jsonl.
  if (sdkSessionId && sdkCwd) {
    const encoded = encodeClaudeProjectPath(sdkCwd);
    if (encoded) {
      candidates.push(path.join(getCraftAgentClaudeDirectory(), "projects", encoded, `${sdkSessionId}.jsonl`));
    }
  }

  let maxMtime = 0;
  for (const candidate of candidates) {
    const stat = await safeStat(candidate);
    if (stat?.isFile()) {
      maxMtime = Math.max(maxMtime, Number(stat.mtimeMs));
    }
  }

  const copilotEvents = sdkSessionId
    ? [path.join(sessionPath, ".copilot-sdk", "session-state", sdkSessionId, "events.jsonl")]
    : await walkDir(path.join(sessionPath, ".copilot-sdk", "session-state"), ".jsonl");
  for (const file of copilotEvents) {
    const stat = await safeStat(file);
    if (stat?.isFile()) {
      maxMtime = Math.max(maxMtime, Number(stat.mtimeMs));
    }
  }

  const rolloutFiles = await walkDir(path.join(sessionPath, ".codex-home", "sessions"), ".jsonl");
  for (const file of rolloutFiles) {
    const stat = await safeStat(file);
    if (stat?.isFile()) {
      maxMtime = Math.max(maxMtime, Number(stat.mtimeMs));
    }
  }

  return maxMtime;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatEurekaEngine(engine: string | undefined, providers?: Set<string>): string {
  const engineStr = (engine ?? "").toLowerCase();
  // Prefer provider signal — the Eureka header's `engine` only reflects the
  // SDK protocol (claude/codex), not the actual upstream. For claude-engine
  // sessions, the real provider (anthropic / github_copilot / ...) comes
  // from llm-telemetry.
  if (engineStr.includes("codex")) return "Eureka + Codex";
  if (providers && providers.size > 0) {
    const lowered = new Set(Array.from(providers).map((p) => p.toLowerCase()));
    if ([...lowered].some((p) => p.includes("copilot"))) return "Eureka + Copilot";
    if (lowered.has("anthropic")) return "Eureka + CC";
  }
  if (engineStr.includes("claude")) return "Eureka + CC";
  return "Eureka";
}

async function safeStat(target: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}
