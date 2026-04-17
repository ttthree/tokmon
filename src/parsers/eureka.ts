import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { getCraftAgentClaudeDirectory, getHomeDirectory } from "../core/config.js";
import { normalizeProjectPath } from "../core/project.js";
import type { FileCursor, ParseResult, Parser, ParserContext, Session, TokenBreakdown } from "../core/types.js";

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
  turns: Set<string>;
  calls: number;
  totalDurationMs: number;
  models: Set<string>;
  providers: Set<string>;
  tokens: TokenBreakdown;
  headerTokens?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  sdkSessionId?: string;
  sdkCwd?: string;
  engine?: string;
  headerModel?: string;
  modelUsage?: Record<string, TokenBreakdown>;
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
    const sessions: Session[] = [];
    const cursorUpdates: Record<string, FileCursor> = {};

    // Eureka stores sessions in ~/.craft-agent/workspaces/{workspace-id}/sessions/{session-id}/
    const craftAgentDir = path.join(getHomeDirectory(), ".craft-agent");
    const workspacesDir = path.join(craftAgentDir, "workspaces");

    const stat = await safeStat(workspacesDir);
    if (!stat?.isDirectory()) {
      return { sessions, cursorUpdates };
    }

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

        // Check cursor for incremental processing
        const cursor = context.existingCursor.files[primaryFile] ?? null;
        if (cursor && cursor.inode === Number(primaryStat.ino) && cursor.size === primaryStat.size && cursor.mtimeMs === primaryStat.mtimeMs) {
          continue; // Already processed and unchanged
        }

        const session = await parseEurekaSession(
          sessionDir.name,
          sessionPath,
          telemetryStat?.isFile() ? telemetryPath : null,
          sessionJsonlStat?.isFile() ? sessionJsonlPath : null,
          workspace.name,
          context.machineId,
        );

        if (session) {
          sessions.push(session);
          cursorUpdates[primaryFile] = {
            path: primaryFile,
            inode: Number(primaryStat.ino),
            size: Number(primaryStat.size),
            mtimeMs: Number(primaryStat.mtimeMs),
            byteOffset: Number(primaryStat.size),
            processedAt: new Date().toISOString(),
          };
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
): Promise<Session | null> {
  const meta: SessionMeta = {
    turns: new Set(),
    calls: 0,
    totalDurationMs: 0,
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

        // Token usage from header: used for Anthropic sessions only.
        // The header's tokenUsage has accurate cache breakdown (inputTokens is INCLUSIVE).
        // For Codex sessions, we use per-call telemetry data instead (see below).
        // Sessions never mix Anthropic and Codex providers.
        if (header.tokenUsage) {
          meta.headerTokens = {
            input: header.tokenUsage.inputTokens ?? 0,
            output: header.tokenUsage.outputTokens ?? 0,
            cacheRead: header.tokenUsage.cacheReadTokens ?? 0,
            cacheCreation: header.tokenUsage.cacheCreationTokens ?? 0,
          };
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

      // Track turns and calls
      if (entry.turnId) meta.turns.add(entry.turnId);
      meta.calls += 1;

      // Track duration
      if (entry.durationMs && Number.isFinite(entry.durationMs)) {
        meta.totalDurationMs += entry.durationMs;
      }

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
  const engine = (meta.engine ?? "").toLowerCase();
  const hasNonAnthropicTokens = meta.tokens.input > 0 || meta.tokens.output > 0 || meta.tokens.cacheRead > 0;

  if (meta.sdkSessionId) {
    if (engine.includes("codex")) {
      const result = await readCodexSessionTokens(sessionPath, meta.sdkSessionId, meta.headerModel);
      if (result) {
        meta.tokens = result.tokens;
        meta.modelUsage = result.modelUsage;
        for (const m of result.models) meta.models.add(m);
      }
      claimedCcSessionIds.add(meta.sdkSessionId);
    } else {
      const result = await readCcSessionTokens(meta.sdkSessionId, meta.sdkCwd);
      if (result) {
        meta.tokens = result.tokens;
        meta.modelUsage = result.modelUsage;
        for (const m of result.models) meta.models.add(m);
      }
      claimedCcSessionIds.add(meta.sdkSessionId);
    }
  }
  // Sessions without sdkSessionId: no token/cost attribution here.
  // Their CC sub-agent files are picked up by the CC parser as source="claude-code".

  // Need at least some data to create a session
  if (!meta.firstTimestamp && !meta.lastTimestamp) {
    return null;
  }

  const createdAt = meta.firstTimestamp ?? new Date(0).toISOString();
  const modifiedAt = meta.lastTimestamp ?? createdAt;
  const durationSeconds = meta.totalDurationMs > 0
    ? Math.round(meta.totalDurationMs / 1000)
    : Math.max(0, Math.round((Date.parse(modifiedAt) - Date.parse(createdAt)) / 1000));

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
  const isWorkspacePath = projectPath.includes("/.craft-agent/workspaces/");
  const project = isWorkspacePath
    ? "Eureka"
    : path.basename(normalizeProjectPath(projectPath)) || workspaceId;

  return {
    id: sessionId,
    machineId,
    source: "eureka",
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
  };
}

interface SdkTokenResult {
  tokens: TokenBreakdown;
  models: string[];
  modelUsage: Record<string, TokenBreakdown>;
}

/**
 * Read tokens + models from a Claude Code .jsonl file identified by sdkSessionId.
 */
async function readCcSessionTokens(sdkSessionId: string, sdkCwd?: string): Promise<SdkTokenResult | null> {
  if (!sdkCwd) return null;
  const encodedCwd = sdkCwd.replace(/[/.]/g, "-");
  const ccDir = path.join(getCraftAgentClaudeDirectory(), "projects", encodedCwd);
  const mainFile = path.join(ccDir, `${sdkSessionId}.jsonl`);

  const tokens: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const models = new Set<string>();
  const modelUsage: Record<string, TokenBreakdown> = {};
  let found = false;

  if (await safeStat(mainFile)) {
    extractTokensFromCcFile(await readFileWithSizeLimit(mainFile), tokens, models, modelUsage);
    found = true;
  }

  const subDir = path.join(ccDir, sdkSessionId, "subagents");
  try {
    const subs = await fs.readdir(subDir);
    for (const sub of subs) {
      if (!sub.endsWith(".jsonl")) continue;
      extractTokensFromCcFile(await readFileWithSizeLimit(path.join(subDir, sub)), tokens, models, modelUsage);
      found = true;
    }
  } catch { /* no sub-agents */ }

  return found ? { tokens, models: [...models], modelUsage } : null;
}

/**
 * Read tokens from a Codex session file in .codex-home/sessions/.
 */
async function readCodexSessionTokens(sessionPath: string, sdkSessionId: string, fallbackModel?: string): Promise<SdkTokenResult | null> {
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

async function extractCodexTurnModelUsage(filePath: string, fallbackModel?: string): Promise<SdkTokenResult | null> {
  const tokens: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const models = new Set<string>();
  const modelUsage: Record<string, TokenBreakdown> = {};
  let currentModel = fallbackModel;
  let previousUsage: CodexTokenUsage | null = null;
  let foundUsage = false;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      const parsed = parseJsonLine<CodexRolloutEvent>(line);
      if (!parsed) continue;

      if (parsed.type === "turn_context") {
        const turnModel = typeof parsed.payload?.model === "string" ? parsed.payload.model : undefined;
        if (turnModel) {
          currentModel = turnModel;
          models.add(turnModel);
        }
        continue;
      }

      const totalUsage = parsed.payload?.info?.total_token_usage;
      if (!totalUsage || typeof totalUsage.input_tokens !== "number") continue;

      const delta = previousUsage
        ? diffCodexUsage(totalUsage, previousUsage)
        : {
            input_tokens: numberOrZero(totalUsage.input_tokens),
            cached_input_tokens: numberOrZero(totalUsage.cached_input_tokens),
            output_tokens: numberOrZero(totalUsage.output_tokens),
          };
      previousUsage = totalUsage;

      if (!delta) continue;

      foundUsage = true;
      const currentTokens = codexUsageToBreakdown(delta);
      tokens.input += currentTokens.input;
      tokens.output += currentTokens.output;
      tokens.cacheCreation += currentTokens.cacheCreation;
      tokens.cacheRead += currentTokens.cacheRead;

      const attributionModel = currentModel ?? fallbackModel;
      if (!attributionModel) continue;
      models.add(attributionModel);
      const usage = modelUsage[attributionModel] ?? (modelUsage[attributionModel] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
      usage.input += currentTokens.input;
      usage.output += currentTokens.output;
      usage.cacheCreation += currentTokens.cacheCreation;
      usage.cacheRead += currentTokens.cacheRead;
    }
  } finally {
    reader.close();
    stream.close();
  }

  if (!foundUsage) {
    return null;
  }

  if (models.size === 0 && fallbackModel) {
    models.add(fallbackModel);
    modelUsage[fallbackModel] = { ...tokens };
  }

  return { tokens, models: [...models], modelUsage };
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

/** Read a file, capping large files to head+tail to avoid OOM. */
async function readFileWithSizeLimit(filePath: string): Promise<string> {
  const stat = await safeStat(filePath);
  const fileSize = Number(stat?.size ?? 0);
  const THRESHOLD = 5 * 1024 * 1024;
  if (fileSize <= THRESHOLD) {
    return fs.readFile(filePath, "utf8");
  }
  // Large file: read first 256KB + last 64KB
  const handle = await fs.open(filePath, "r");
  try {
    const headSize = 256 * 1024;
    const tailSize = 64 * 1024;
    const headBuf = Buffer.alloc(headSize);
    const tailBuf = Buffer.alloc(tailSize);
    await handle.read(headBuf, 0, headSize, 0);
    await handle.read(tailBuf, 0, tailSize, fileSize - tailSize);
    return headBuf.toString("utf8") + "\n" + tailBuf.toString("utf8");
  } finally {
    await handle.close();
  }
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

/** Search backwards through a file for the last total_token_usage entry. Reads in 64KB chunks from the end. */
async function searchBackwardsForTokenUsage(handle: fs.FileHandle, fileSize: number): Promise<CodexTokenUsage | null> {
  const CHUNK = 64 * 1024;
  let offset = Math.max(0, fileSize - CHUNK);
  let leftover = "";

  while (offset >= 0) {
    const readSize = Math.min(CHUNK, fileSize - offset);
    const buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, offset);
    const chunk = buf.toString("utf8") + leftover;

    // Scan lines in reverse
    const lines = chunk.split(/\r?\n/);
    leftover = lines[0]; // partial first line carries over to next chunk
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i];
      if (!line.includes("total_token_usage")) continue;
      try {
        const parsed = JSON.parse(line) as { payload?: { info?: { total_token_usage?: CodexTokenUsage } } };
        const usage = parsed?.payload?.info?.total_token_usage;
        if (usage && typeof usage.input_tokens === "number") {
          return usage;
        }
      } catch { /* malformed line */ }
    }

    if (offset === 0) break;
    offset = Math.max(0, offset - CHUNK);
  }
  return null;
}

/** Extract token usage and models from CC .jsonl content. */
function extractTokensFromCcFile(content: string, tokens: TokenBreakdown, models: Set<string>, modelUsage: Record<string, TokenBreakdown>): void {
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes('"assistant"')) continue;

    const modelMatch = line.match(/"model"\s*:\s*"([^"]+)"/);
    const lineModel = modelMatch?.[1];
    if (lineModel && !lineModel.startsWith("<")) {
      models.add(lineModel);
    }

    if (!line.includes('"usage"')) continue;
    const start = line.indexOf('"usage"');
    const brace = line.indexOf("{", start + 7);
    if (brace === -1) continue;
    let depth = 0;
    let end = brace;
    for (; end < line.length && end < brace + 1000; end++) {
      if (line[end] === "{") depth++;
      else if (line[end] === "}") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    try {
      const usage = JSON.parse(line.slice(brace, end + 1)) as Record<string, unknown>;
      const inp = numberOrZero(usage.input_tokens);
      const out = numberOrZero(usage.output_tokens);
      const cw = numberOrZero(usage.cache_creation_input_tokens);
      const cr = numberOrZero(usage.cache_read_input_tokens);
      tokens.input += inp;
      tokens.output += out;
      tokens.cacheCreation += cw;
      tokens.cacheRead += cr;
      if (lineModel && (inp > 0 || out > 0 || cr > 0)) {
        const mu = modelUsage[lineModel] ?? (modelUsage[lineModel] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
        mu.input += inp;
        mu.output += out;
        mu.cacheCreation += cw;
        mu.cacheRead += cr;
      }
    } catch { /* malformed */ }
  }
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

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
