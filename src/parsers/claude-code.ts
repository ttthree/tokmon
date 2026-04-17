import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getClaudeDirectory, getCraftAgentClaudeDirectory } from "../core/config.js";
import { computeActiveDurationSeconds } from "../core/duration.js";
import { normalizeProjectPath } from "../core/project.js";
import { claimedCcSessionIds } from "./eureka.js";
import { marsRegistry } from "./mars.js";
import { applyMarsMeta } from "./orchestrator.js";
import type { FileCursor, ParseResult, Parser, ParserContext, Session, TokenBreakdown } from "../core/types.js";

interface ClaudeSessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created: string;
  modified: string;
  projectPath: string;
  isSidechain?: boolean;
}

interface ClaudeMessageEnvelope {
  type?: string;
  sessionId?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content?: Array<{ type?: string; name?: string }>;
  model?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    content?: Array<{ type?: string; name?: string }>;
  };
}

export const claudeCodeParser: Parser = {
  source: "claude-code",
  async parse(context: ParserContext): Promise<ParseResult> {
    const sessions: Session[] = [];
    const cursorUpdates: Record<string, FileCursor> = {};

    // Scan ~/.claude (direct CLI sessions → source="claude-code") and
    // ~/.craft-agent/.claude (Eureka sub-agents → source="claude-code" for unclaimed files).
    // Files claimed by Eureka parser (via sdkSessionId) are skipped to avoid double-counting.
    const enabledClaude = (context.sources ?? [])
      .filter((s) => s.enabled && s.type === "claude-code")
      .map((s) => s.path);
    const craftAgentClaude = getCraftAgentClaudeDirectory();
    const directories: Array<{ dir: string; excludeClaimed: boolean }> = [
      ...(enabledClaude.length > 0
        ? enabledClaude.map((dir) => ({ dir, excludeClaimed: dir === craftAgentClaude }))
        : [
            { dir: getClaudeDirectory(), excludeClaimed: false },
            { dir: craftAgentClaude, excludeClaimed: true },
          ]),
      ...marsRegistry.claudeRoots.map((dir) => ({ dir, excludeClaimed: false })),
    ];

    for (const { dir: claudeDir, excludeClaimed } of directories) {
      const rootDir = path.join(claudeDir, "projects");

      // Build index from sessions-index.json files (may be stale)
      const indexFiles = await findFiles(rootDir, "sessions-index.json");
      const indexByPath = new Map<string, ClaudeSessionIndexEntry>();
      for (const indexFile of indexFiles) {
        const entries = await readIndexEntries(indexFile);
        for (const entry of entries) {
          if (entry.isSidechain) continue;
          const sessionPath = await resolveSessionPath(indexFile, entry.fullPath);
          indexByPath.set(sessionPath, entry);
        }
      }

      // Scan ALL .jsonl files directly (works around stale sessions-index.json)
      const allJsonlFiles = await findFiles(rootDir, "*.jsonl");
      for (let fileIndex = 0; fileIndex < allJsonlFiles.length; fileIndex++) {
        const sessionPath = allJsonlFiles[fileIndex];

        // Yield to event loop periodically to allow GC to reclaim file buffers
        if (fileIndex > 0 && fileIndex % 200 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        // Skip files claimed by Eureka parser (matched via sdkSessionId)
        if (excludeClaimed) {
          const fileSessionId = path.basename(sessionPath, ".jsonl");
          if (claimedCcSessionIds.has(fileSessionId)) continue;
          // Also skip sub-agent files whose parent is claimed
          const parentDir = path.basename(path.dirname(path.dirname(sessionPath)));
          if (claimedCcSessionIds.has(parentDir)) continue;
        }

        const sessionCursor = context.existingCursor.files[sessionPath] ?? null;
        const stat = await safeStat(sessionPath);
        if (!stat || !stat.isFile()) continue;

        // Skip if already processed and unchanged
        if (sessionCursor && sessionCursor.inode === Number(stat.ino) && sessionCursor.size === stat.size && sessionCursor.mtimeMs === stat.mtimeMs) {
          continue;
        }

        // Use index entry if available, otherwise synthesize from file metadata
        const indexEntry = indexByPath.get(sessionPath);
        const entry = indexEntry ?? await synthesizeEntryFromFile(sessionPath, stat);

        let session = await parseClaudeSessionFile(sessionPath, entry, context.machineId);
        const marsMeta = marsRegistry.byAgentSessionId.claudeCode.get(session.id);
        if (marsMeta) {
          session = applyMarsMeta(session, marsMeta, "claude-code");
        }
        // Skip empty sessions (no tokens = no meaningful API interactions)
        if (session.tokens.input === 0 && session.tokens.output === 0 && session.tokens.cacheRead === 0 && session.tokens.cacheCreation === 0) {
          cursorUpdates[sessionPath] = {
            path: sessionPath,
            inode: Number(stat.ino),
            size: Number(stat.size),
            mtimeMs: Number(stat.mtimeMs),
            byteOffset: Number(stat.size),
            processedAt: new Date().toISOString(),
          };
          continue;
        }
        sessions.push(session);
        cursorUpdates[sessionPath] = {
          path: sessionPath,
          inode: Number(stat.ino),
          size: Number(stat.size),
          mtimeMs: Number(stat.mtimeMs),
          byteOffset: Number(stat.size),
          processedAt: new Date().toISOString(),
        };
      }
    }

    return { sessions, cursorUpdates };
  },
};

async function synthesizeEntryFromFile(sessionPath: string, stat: Awaited<ReturnType<typeof fs.stat>>): Promise<ClaudeSessionIndexEntry> {
  const sessionId = path.basename(sessionPath, ".jsonl");
  const meta = await extractFileMetadata(sessionPath);
  const projectPath = await synthesizeProjectPath(sessionPath, meta.cwd);

  return {
    sessionId,
    fullPath: sessionPath,
    fileMtime: Number(stat.mtimeMs),
    firstPrompt: meta.firstPrompt,
    created: new Date(Number(stat.birthtimeMs)).toISOString(),
    modified: new Date(Number(stat.mtimeMs)).toISOString(),
    projectPath: projectPath.startsWith("/") ? projectPath : "/" + projectPath,
  };
}

async function synthesizeProjectPath(sessionPath: string, fileCwd?: string): Promise<string> {
  const projectDir = path.dirname(sessionPath);
  const subagentDir = path.basename(projectDir) === "subagents" ? projectDir : null;
  const encodedProjectDir = subagentDir
    ? path.dirname(path.dirname(projectDir))
    : projectDir;
  const encodedProjectDirName = path.basename(encodedProjectDir);

  if (subagentDir) {
    const parentSessionId = path.basename(path.dirname(subagentDir));
    const indexedProjectPath = await resolveSubagentProjectPathFromIndex(encodedProjectDir, parentSessionId);
    if (indexedProjectPath) {
      return indexedProjectPath.replace(/^\//, "");
    }

    const eurekaSessionId = extractEurekaSessionIdFromEncodedDir(encodedProjectDirName);
    if (eurekaSessionId) {
      const sessionDir = await findEurekaSessionDirById(eurekaSessionId);
      const workingDirectory = sessionDir ? await resolveEurekaWorkingDirectory(sessionDir) : null;
      if (workingDirectory) {
        return workingDirectory.replace(/^\//, "");
      }
    }
  }

  // Prefer cwd recorded in the JSONL file — it's the ground truth and avoids
  // ambiguous decoding of the encoded project directory name (e.g. `craft-agents`
  // vs `craft/agents`, since both '.' and '/' encode to '-').
  if (fileCwd) {
    return fileCwd;
  }

  return decodeEncodedProjectPath(encodedProjectDirName);
}

async function extractFileMetadata(sessionPath: string): Promise<{ cwd?: string; firstPrompt?: string }> {
  const handle = await fs.open(sessionPath, "r").catch(() => null);
  if (!handle) return {};
  try {
    const stat = await handle.stat();
    const size = Math.min(Number(stat.size), 64 * 1024);
    if (size === 0) return {};
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    const content = buf.toString("utf8");

    let cwd: string | undefined;
    let firstPrompt: string | undefined;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!cwd && typeof parsed.cwd === "string" && (parsed.cwd as string).trim()) {
        cwd = (parsed.cwd as string).trim();
      }
      if (!firstPrompt && parsed.type === "user") {
        const message = parsed.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "user") {
          const text = extractUserPromptText(message.content);
          if (text) {
            firstPrompt = text;
          }
        }
      }
      if (cwd && firstPrompt) break;
    }
    return { cwd, firstPrompt };
  } finally {
    await handle.close();
  }
}

function extractUserPromptText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return truncatePrompt(content);
  }
  if (!Array.isArray(content)) return undefined;

  // Skip tool_result-only user turns — those aren't real user prompts.
  const hasToolResult = content.some(
    (item) => item && typeof item === "object" && (item as { type?: string }).type === "tool_result",
  );
  if (hasToolResult) {
    const allToolResult = content.every(
      (item) => item && typeof item === "object" && (item as { type?: string }).type === "tool_result",
    );
    if (allToolResult) return undefined;
  }

  for (const item of content) {
    if (item && typeof item === "object") {
      const it = item as { type?: string; text?: string };
      if (it.type === "text" && typeof it.text === "string" && it.text.trim()) {
        return truncatePrompt(it.text);
      }
    }
  }
  return undefined;
}

function truncatePrompt(value: string, max = 500): string {
  const cleaned = value.trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + "…";
}

async function resolveSubagentProjectPathFromIndex(encodedProjectDir: string, parentSessionId: string): Promise<string | null> {
  const indexFile = path.join(encodedProjectDir, "sessions-index.json");
  const entries = await readIndexEntries(indexFile);
  const entry = entries.find((candidate) => candidate.sessionId === parentSessionId);
  if (!entry?.projectPath) {
    return null;
  }
  return resolveEurekaWorkingDirectory(entry.projectPath);
}

async function resolveEurekaWorkingDirectory(projectPath: string): Promise<string | null> {
  const home = process.env.TOKMON_HOME ?? os.homedir();
  const sessionDir = projectPath.replace(/^~(?=[\\/])/, home);
  const normalized = sessionDir.replace(/\\/g, "/");
  if (!/\/\.(craft-agent|eureka)\/workspaces\//.test(normalized) || !normalized.includes("/sessions/")) {
    return projectPath;
  }

  const headerPath = path.join(sessionDir, "session.jsonl");
  const raw = await fs.readFile(headerPath, "utf8").catch(() => "");
  const firstLine = raw.split(/\r?\n/)[0];
  if (!firstLine) {
    return projectPath;
  }

  try {
    const header = JSON.parse(firstLine) as { workingDirectory?: string };
    if (typeof header.workingDirectory === "string" && header.workingDirectory.trim()) {
      return header.workingDirectory.replace(/^~(?=[\\/])/, home);
    }
  } catch {
    // fall through
  }

  return projectPath;
}

function extractEurekaSessionIdFromEncodedDir(encodedProjectDirName: string): string | null {
  const match = encodedProjectDirName.match(/-sessions-(.+)$/);
  return match?.[1] ?? null;
}

function decodeEncodedProjectPath(projectDirName: string): string {
  return projectDirName.startsWith("-")
    ? projectDirName.slice(1).replace(/-/g, "/")
    : projectDirName;
}

function getHomeCraftAgentWorkspacesDir(): string {
  const home = process.env.TOKMON_HOME ?? os.homedir();
  return path.join(home, ".craft-agent", "workspaces");
}

async function findEurekaSessionDirById(sessionId: string): Promise<string | null> {
  const workspacesDir = getHomeCraftAgentWorkspacesDir();
  const workspaces = await fs.readdir(workspacesDir, { withFileTypes: true }).catch(() => []);
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const candidate = path.join(workspacesDir, workspace.name, "sessions", sessionId);
    const stat = await safeStat(candidate);
    if (stat?.isDirectory()) {
      return candidate;
    }
  }
  return null;
}

export async function readClaudeJsonlIncrementally(filePath: string, cursor: FileCursor | null = null): Promise<{ lines: string[]; cursor: FileCursor }> {
  const stat = await fs.stat(filePath);
  const startOffset = cursor && cursor.inode === Number(stat.ino) && cursor.size <= stat.size ? cursor.byteOffset : 0;
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(stat.size - startOffset, 0));
    if (buffer.length > 0) {
      await handle.read(buffer, 0, buffer.length, startOffset);
    }
    return {
      lines: buffer.toString("utf8").split(/\r?\n/).filter((line) => line.trim()),
      cursor: {
        path: filePath,
        inode: Number(stat.ino),
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeMs),
        byteOffset: Number(stat.size),
        processedAt: new Date().toISOString(),
      },
    };
  } finally {
    await handle.close();
  }
}

async function parseClaudeSessionFile(sessionFile: string, entry: ClaudeSessionIndexEntry, machineId: string): Promise<Session> {
  const tokens: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const modelUsage: Record<string, TokenBreakdown> = {};
  const toolBreakdown: Record<string, number> = {};
  let toolCallCount = 0;
  let turns = 0;
  let messageCount = 0;
  let model = "unknown";
  const eventTimestampsMs: number[] = [];

  // For large files (>5MB), only read the first 64KB of the file to extract
  // usage data from the message envelope. This avoids multi-GB allocations.
  const stat = await safeStat(sessionFile);
  const fileSize = Number(stat?.size ?? 0);
  const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;
  const LARGE_FILE_READ_SIZE = 64 * 1024;

  let content: string;
  if (fileSize > LARGE_FILE_THRESHOLD) {
    // Read only first chunk + last chunk (usage is typically in assistant turns spread throughout)
    // For large files, do a targeted scan: read file in 64KB chunks, extract usage via regex
    const handle = await fs.open(sessionFile, "r");
    try {
      const buf = Buffer.alloc(Math.min(fileSize, 256 * 1024));
      await handle.read(buf, 0, buf.length, 0);
      content = buf.toString("utf8");
      // Also read last 64KB for final usage/model
      if (fileSize > buf.length) {
        const tailBuf = Buffer.alloc(LARGE_FILE_READ_SIZE);
        await handle.read(tailBuf, 0, tailBuf.length, fileSize - tailBuf.length);
        content += "\n" + tailBuf.toString("utf8");
      }
    } finally {
      await handle.close();
    }
  } else {
    content = await fs.readFile(sessionFile, "utf8");
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const isUser = line.includes('"user"');
    const isAssistant = line.includes('"assistant"');
    if (!isUser && !isAssistant) continue;

    // Capture per-event timestamp for active-duration calculation.
    const tsMatch = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (tsMatch) {
      const ms = Date.parse(tsMatch[1]);
      if (Number.isFinite(ms)) eventTimestampsMs.push(ms);
    }

    if (isUser && !isAssistant) {
      messageCount += 1;
      if (!line.includes('"tool_result"')) turns += 1;
      continue;
    }

    messageCount += 1;

    // Extract model name for this interaction
    const modelMatch = line.match(/"model"\s*:\s*"([^"]+)"/);
    const lineModel = modelMatch?.[1];
    if (lineModel && model === "unknown") model = lineModel;

    // Extract usage and accumulate both total and per-model
    const lineTokens: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    extractUsageFromString(line, lineTokens);
    tokens.input += lineTokens.input;
    tokens.output += lineTokens.output;
    tokens.cacheCreation += lineTokens.cacheCreation;
    tokens.cacheRead += lineTokens.cacheRead;

    if (lineModel && (lineTokens.input > 0 || lineTokens.output > 0 || lineTokens.cacheRead > 0)) {
      const mu = modelUsage[lineModel] ?? (modelUsage[lineModel] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
      mu.input += lineTokens.input;
      mu.output += lineTokens.output;
      mu.cacheCreation += lineTokens.cacheCreation;
      mu.cacheRead += lineTokens.cacheRead;
    }

    const toolMatches = line.matchAll(/"type"\s*:\s*"tool_use"[^}]*?"name"\s*:\s*"([^"]+)"/g);
    for (const m of toolMatches) {
      toolCallCount += 1;
      toolBreakdown[m[1]] = (toolBreakdown[m[1]] ?? 0) + 1;
    }
  }

  const createdAt = toIso(entry.created, entry.fileMtime);
  const modifiedAt = toIso(entry.modified, entry.fileMtime);
  const normalizedPath = normalizeProjectPath(entry.projectPath);
  return {
    id: entry.sessionId,
    machineId,
    source: "claude-code",
    engine: "Claude Code",
    projectPath: entry.projectPath,
    project: path.basename(normalizedPath) || "other",
    summary: entry.summary,
    firstPrompt: entry.firstPrompt,
    model,
    createdAt,
    modifiedAt,
    durationSeconds: computeActiveDurationSeconds(eventTimestampsMs),
    turns,
    messageCount: entry.messageCount ?? messageCount,
    toolCallCount,
    tokens,
    cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    toolBreakdown,
    modelUsage: Object.keys(modelUsage).length > 0 ? modelUsage : undefined,
  };
}

async function readIndexEntries(indexFile: string): Promise<ClaudeSessionIndexEntry[]> {
  const raw = await fs.readFile(indexFile, "utf8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.flatMap(normalizeIndexEntry);
  }
  if (parsed && typeof parsed === "object") {
    const candidate = parsed as { entries?: unknown[]; sessions?: unknown[] };
    if (Array.isArray(candidate.entries)) {
      return candidate.entries.flatMap(normalizeIndexEntry);
    }
    if (Array.isArray(candidate.sessions)) {
      return candidate.sessions.flatMap(normalizeIndexEntry);
    }
  }
  return [];
}

function normalizeIndexEntry(entry: unknown): ClaudeSessionIndexEntry[] {
  if (!entry || typeof entry !== "object") {
    return [];
  }
  const candidate = entry as Record<string, unknown>;
  const sessionId = stringOrEmpty(candidate.sessionId ?? candidate.id);
  const fullPath = stringOrEmpty(candidate.fullPath ?? candidate.path);
  const created = stringOrEmpty(candidate.created ?? candidate.createdAt);
  const modified = stringOrEmpty(candidate.modified ?? candidate.modifiedAt ?? candidate.updatedAt);
  const projectPath = stringOrEmpty(candidate.projectPath ?? candidate.cwd);
  if (!sessionId || !fullPath || !created || !modified || !projectPath) {
    return [];
  }
  return [{
    sessionId,
    fullPath,
    fileMtime: numberOrUndefined(candidate.fileMtime ?? candidate.mtimeMs),
    firstPrompt: stringOrUndefined(candidate.firstPrompt),
    summary: stringOrUndefined(candidate.summary),
    messageCount: numberOrUndefined(candidate.messageCount),
    created,
    modified,
    projectPath,
    isSidechain: Boolean(candidate.isSidechain),
  }];
}

async function resolveSessionPath(indexFile: string, entryPath: string): Promise<string> {
  if (path.isAbsolute(entryPath)) {
    return entryPath;
  }
  const indexDir = path.dirname(indexFile);
  const candidates = [path.resolve(indexDir, entryPath), path.resolve(indexDir, path.basename(entryPath))];
  for (const candidate of candidates) {
    if (await safeStat(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

async function findFiles(rootDir: string, pattern: string): Promise<string[]> {
  const stat = await safeStat(rootDir);
  if (!stat?.isDirectory()) {
    return [];
  }
  const found: string[] = [];
  const isGlob = pattern.includes("*");
  const regex = isGlob ? new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$") : null;

  await walk(rootDir, async (candidate) => {
    const basename = path.basename(candidate);
    if (regex ? regex.test(basename) : basename === pattern) {
      found.push(candidate);
    }
  });
  return found.sort();
}

async function walk(rootDir: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walk(candidate, onFile);
    } else if (entry.isFile()) {
      await onFile(candidate);
    }
  }
}

function extractUsageFromString(line: string, tokens: TokenBreakdown): void {
  const start = line.indexOf('"usage"');
  if (start === -1) return;

  // Find the opening brace after "usage":
  const braceStart = line.indexOf("{", start + 7);
  if (braceStart === -1) return;

  // Match balanced braces to handle nested objects like cache_creation: {...}
  let depth = 0;
  let end = braceStart;
  for (; end < line.length && end < braceStart + 1000; end++) {
    if (line[end] === "{") depth++;
    else if (line[end] === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return;

  try {
    const usage = JSON.parse(line.slice(braceStart, end + 1)) as Record<string, unknown>;
    tokens.input += numberOrZero(usage.input_tokens);
    tokens.output += numberOrZero(usage.output_tokens);
    tokens.cacheCreation += numberOrZero(usage.cache_creation_input_tokens);
    tokens.cacheRead += numberOrZero(usage.cache_read_input_tokens);
  } catch {
    // malformed usage block
  }
}

async function safeStat(target: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function parseJsonLine(line: string): ClaudeMessageEnvelope | null {
  try {
    return JSON.parse(line) as ClaudeMessageEnvelope;
  } catch {
    return null;
  }
}

function toIso(value: string, fallbackMtime?: number): string {
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  if (fallbackMtime && Number.isFinite(fallbackMtime)) {
    return new Date(fallbackMtime).toISOString();
  }
  return new Date(0).toISOString();
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringOrUndefined(value: unknown): string | undefined {
  const normalized = stringOrEmpty(value);
  return normalized || undefined;
}

function numberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return numberOrZero(value);
}
