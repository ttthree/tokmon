import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { Command } from "commander";

export type JsonlKind = "cc" | "eureka-header" | "eureka-body" | "codex" | "telemetry";
export type SqliteKind = "codex" | "mars" | "copilot";

const sessionNameMap = new Map<string, string>();
let sessionNameSeq = 0;

export function resetSanitizeState(): void {
  sessionNameMap.clear();
  sessionNameSeq = 0;
}

export function sanitizePath(input: string): string {
  if (!input) return input;
  return sanitizeSensitiveText(input);
}

export function sanitizeFilename(name: string): string {
  return sanitizePath(name);
}

export function sanitizeSensitiveText(input: string): string {
  if (!input) return input;
  const username = os.userInfo().username;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return input
    .replace(new RegExp(`/Users/${escaped}(?=/|$)`, "gi"), "/Users/testuser")
    .replace(new RegExp(`\\b${escaped}(?:[_-][A-Za-z0-9.-]+)+\\b`, "gi"), "testuser")
    .replace(new RegExp(`\\b${escaped}\\b`, "gi"), "testuser")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email-redacted]");
}

export function sanitizeCopilotLog(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i] ?? "";
    const isTelemetryHeader = header.includes("cli.telemetry:");
    const isModelCallHeader = header.includes("cli.model_call:");
    if (!isTelemetryHeader && !isModelCallHeader) continue;

    const extracted = extractJsonBlock(lines, i);
    if (!extracted) continue;
    i = extracted.nextIndex - 1;

    const parsed = parseJsonSafe(extracted.jsonText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const timestamp = extractHeaderTimestamp(header);

    if (isTelemetryHeader) {
      if (obj.kind !== "assistant_usage") continue;
      const sanitized = sanitizeCopilotAssistantUsage(obj, timestamp);
      out.push(`${timestamp} [INFO] [Telemetry] cli.telemetry:`);
      out.push(JSON.stringify(sanitized));
      continue;
    }

    const sanitized = sanitizeCopilotModelCall(obj, timestamp);
    out.push(`${timestamp} [INFO] [Telemetry] cli.model_call:`);
    out.push(JSON.stringify(sanitized));
  }

  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

export function sanitizeJsonlLine(line: string, kind: JsonlKind): string | null {
  if (!line.trim()) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  if (kind === "cc" || kind === "eureka-body") {
    return JSON.stringify(sanitizeCcLikeLine(record));
  }
  if (kind === "eureka-header") {
    return JSON.stringify(sanitizeEurekaHeader(record));
  }
  if (kind === "codex") {
    return JSON.stringify(sanitizeCodexLine(record));
  }
  return JSON.stringify(sanitizeTelemetryLine(record));
}

export async function sanitizeSqlite(
  srcPath: string,
  dstPath: string,
  kind: SqliteKind,
  options: { selectedIds?: Set<string> } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(dstPath), { recursive: true });
  await fs.rm(dstPath, { force: true }).catch(() => undefined);

  if (kind === "codex") {
    sanitizeCodexSqlite(srcPath, dstPath, options.selectedIds);
    return;
  }
  if (kind === "copilot") {
    sanitizeCopilotSqlite(srcPath, dstPath);
    return;
  }
  sanitizeMarsSqlite(srcPath, dstPath, options.selectedIds);
}

export async function sanitizeCorpusDir(corpusRoot: string): Promise<void> {
  const root = path.resolve(corpusRoot);
  const files = await walk(root);
  for (const file of files) {
    if (file.endsWith(".sqlite")) {
      const tmp = `${file}.tmp`;
      const kind = path.basename(file) === "marsiwe.db" ? "mars" : "codex";
      await sanitizeSqlite(file, tmp, kind);
      await fs.rename(tmp, file);
      continue;
    }
    if (file.endsWith(".jsonl")) {
      await sanitizeJsonlFileInPlace(file);
      continue;
    }
    if (file.endsWith(".log")) {
      const raw = await fs.readFile(file, "utf8");
      await fs.writeFile(file, sanitizeCopilotLog(raw), "utf8");
    }
  }
}

export function registerCorpusSanitize(command: Command): void {
  command
    .command("sanitize")
    .argument("<corpus>")
    .action(async (corpus: string) => {
      await sanitizeCorpusDir(corpus);
      console.log(`Corpus sanitized: ${corpus}`);
    });
}

function sanitizeCcLikeLine(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["type", "timestamp", "sessionId", "parentUuid", "uuid", "isSidechain", "gitBranch", "userType", "version"]) {
    if (key in parsed) out[key] = parsed[key];
  }
  if (typeof parsed.cwd === "string") out.cwd = sanitizePath(parsed.cwd);
  if ("summary" in parsed) out.summary = "";

  const message = parsed.message;
  if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    const msg: Record<string, unknown> = {};
    for (const key of ["role", "model", "usage", "id", "stop_reason"]) {
      if (key in m) msg[key] = key === "model" && typeof m[key] === "string" ? sanitizePath(m[key] as string) : m[key];
    }
    if (Array.isArray(m.content)) {
      msg.content = m.content.map((item) => sanitizeContentItem(item));
    }
    out.message = msg;
  }

  if (parsed.toolUseResult && typeof parsed.toolUseResult === "object") {
    const tur = parsed.toolUseResult as Record<string, unknown>;
    if (typeof tur.totalTokens === "number") {
      out.toolUseResult = { totalTokens: tur.totalTokens };
    }
  }
  return out;
}

function sanitizeEurekaHeader(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["id", "engine", "sdkSessionId", "tokenUsage", "costUsd", "messageCount", "userMessageCount", "model", "createdAt", "updatedAt"]) {
    if (key in parsed) out[key] = parsed[key];
  }
  if (typeof parsed.sdkCwd === "string") out.sdkCwd = sanitizePath(parsed.sdkCwd);
  if (typeof parsed.workingDirectory === "string") out.workingDirectory = sanitizePath(parsed.workingDirectory);
  out.name = rewriteSessionName(typeof parsed.id === "string" ? parsed.id : undefined);
  return out;
}

function sanitizeCodexLine(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("type" in parsed) out.type = parsed.type;
  if ("timestamp" in parsed) out.timestamp = parsed.timestamp;
  const payload = parsed.payload;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (p.type === "token_count") {
      out.payload = payload;
    } else {
      const small: Record<string, unknown> = {};
      for (const key of ["type", "id", "tool_name", "call_id"]) {
        if (key in p) small[key] = p[key];
      }
      out.payload = small;
    }
  }
  return out;
}

function sanitizeTelemetryLine(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["timestamp", "provider", "model", "turnId", "duration", "requestId"]) {
    if (key in parsed) out[key] = parsed[key];
  }
  if ("prompt" in parsed) out.prompt = null;
  if ("response" in parsed) out.response = null;
  if ("text" in parsed) out.text = null;
  return out;
}

function sanitizeCopilotAssistantUsage(parsed: Record<string, unknown>, timestamp: string): Record<string, unknown> {
  const properties = parsed.properties && typeof parsed.properties === "object"
    ? parsed.properties as Record<string, unknown>
    : {};
  const metrics = parsed.metrics && typeof parsed.metrics === "object"
    ? parsed.metrics as Record<string, unknown>
    : {};
  return {
    kind: "assistant_usage",
    timestamp,
    properties: pickAndSanitize(properties, ["event_id", "api_call_id", "model", "interaction_id", "copilot_pid"]),
    metrics: pickNumeric(metrics, ["input_tokens", "input_tokens_uncached", "output_tokens", "cache_read_tokens", "cache_write_tokens", "duration", "duration_ms"]),
  };
}

function sanitizeCopilotModelCall(parsed: Record<string, unknown>, timestamp: string): Record<string, unknown> {
  const out: Record<string, unknown> = { timestamp };
  for (const key of [
    "api_id",
    "event_id",
    "id",
    "model",
    "interaction_id",
    "session_id",
    "copilot_pid",
    "prompt_tokens_count",
    "completion_tokens_count",
    "input_tokens",
    "input_tokens_uncached",
    "output_tokens",
    "cache_read_tokens",
    "cached_tokens_count",
    "cache_write_tokens",
    "duration",
    "duration_ms",
  ]) {
    const value = parsed[key];
    if (typeof value === "string") out[key] = sanitizeSensitiveText(value);
    else if (typeof value === "number") out[key] = value;
  }
  return out;
}

function sanitizeContentItem(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const src = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["type", "name", "tool_use_id", "id", "is_error"]) {
    if (key in src) out[key] = src[key];
  }

  if ("input" in src) {
    out.input = blankStructure(src.input);
  }
  if ("text" in src) out.text = "";
  if ("content" in src) out.content = "";
  return out;
}

function pickAndSanitize(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") out[key] = sanitizeSensitiveText(value);
  }
  return out;
}

function pickNumeric(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function extractHeaderTimestamp(header: string): string {
  const candidate = header.match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/)?.[1] ?? "";
  if (candidate && Number.isFinite(Date.parse(candidate))) return candidate;
  return new Date(0).toISOString();
}

function extractJsonBlock(lines: string[], headerIndex: number): { jsonText: string; nextIndex: number } | null {
  let start = headerIndex + 1;
  while (start < lines.length && !lines[start].trim()) start += 1;
  if (start >= lines.length) return null;

  const first = lines[start];
  if (!first.trim().startsWith("{")) return null;
  let depth = 0;
  const block: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    block.push(line);
    for (const ch of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
    }
    if (depth === 0) {
      return { jsonText: block.join("\n"), nextIndex: i + 1 };
    }
  }

  return null;
}

function blankStructure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => blankStructure(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = blankStructure((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "string") return "";
  return null;
}

function rewriteSessionName(id?: string): string {
  if (!id) {
    sessionNameSeq += 1;
    return `session-${sessionNameSeq}`;
  }
  const found = sessionNameMap.get(id);
  if (found) return found;
  sessionNameSeq += 1;
  const value = `session-${sessionNameSeq}`;
  sessionNameMap.set(id, value);
  return value;
}

async function sanitizeJsonlFileInPlace(filePath: string): Promise<void> {
  const raw = await fs.readFile(filePath, "utf8");
  const kind = classifyJsonlKind(filePath);
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineKind = kind === "eureka-session" ? (i === 0 ? "eureka-header" : "eureka-body") : kind;
    const sanitized = sanitizeJsonlLine(lines[i], lineKind as JsonlKind);
    if (sanitized !== null) out.push(sanitized);
  }
  await fs.writeFile(filePath, out.join("\n") + "\n", "utf8");
}

function classifyJsonlKind(filePath: string): JsonlKind | "eureka-session" {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith("/llm-telemetry.jsonl")) return "telemetry";
  if (normalized.endsWith("/session.jsonl") && normalized.includes("/workspaces/")) return "eureka-session";
  if (normalized.includes("/.codex/")) return "codex";
  if (normalized.includes("/.codex-home/sessions/")) return "codex";
  return "cc";
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await visit(root);
  return out;
}

function sanitizeCodexSqlite(srcPath: string, dstPath: string, selectedIds?: Set<string>): void {
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const dst = new Database(dstPath);
  try {
    dst.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, tokens_used INTEGER);");
    const rows = src.prepare("SELECT id, cwd, title, created_at, updated_at, tokens_used FROM threads").all() as Array<Record<string, unknown>>;
    const insert = dst.prepare("INSERT INTO threads (id, cwd, title, created_at, updated_at, tokens_used) VALUES (?, ?, ?, ?, ?, ?)");
    let seq = 0;
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (!id) continue;
      if (selectedIds && !selectedIds.has(id)) continue;
      seq += 1;
      insert.run(
        id,
        typeof row.cwd === "string" ? sanitizePath(row.cwd) : "",
        `thread-${seq}`,
        Number(row.created_at ?? 0),
        Number(row.updated_at ?? 0),
        Number(row.tokens_used ?? 0),
      );
    }
  } catch {
    // If source db doesn't have a threads table, keep an empty canonical schema.
  } finally {
    src.close();
    dst.close();
  }
}

function sanitizeMarsSqlite(srcPath: string, dstPath: string, selectedTaskIds?: Set<string>): void {
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const dst = new Database(dstPath);
  try {
    dst.exec(
      "CREATE TABLE workspaces (id BLOB PRIMARY KEY, name TEXT, path TEXT);" +
      "CREATE TABLE tasks (id BLOB PRIMARY KEY, workspace_id BLOB, title TEXT, status TEXT);" +
      "CREATE TABLE sessions (id BLOB PRIMARY KEY, workspace_id BLOB, task_id BLOB, agent_type TEXT, agent_session_id TEXT, name TEXT, is_background INTEGER, phase_order INTEGER, updated_at TEXT);",
    );

    const tasks = src.prepare("SELECT id, workspace_id, status FROM tasks").all() as Array<{ id: Buffer; workspace_id: Buffer | null; status: string | null }>;
    const keepTaskHex = new Set<string>();
    for (const task of tasks) {
      const idHex = task.id.toString("hex").toLowerCase();
      if (!selectedTaskIds || selectedTaskIds.has(idHex)) keepTaskHex.add(idHex);
    }

    const workspaces = src.prepare("SELECT id FROM workspaces").all() as Array<{ id: Buffer }>;
    const workspaceName = new Map<string, string>();
    let wseq = 0;
    const insW = dst.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)");
    for (const row of workspaces) {
      const hex = row.id.toString("hex").toLowerCase();
      wseq += 1;
      const name = `workspace-${wseq}`;
      workspaceName.set(hex, name);
      insW.run(row.id, name, `/Users/testuser/work/${name}`);
    }

    const insT = dst.prepare("INSERT INTO tasks (id, workspace_id, title, status) VALUES (?, ?, ?, ?)");
    let tseq = 0;
    for (const row of tasks) {
      const idHex = row.id.toString("hex").toLowerCase();
      if (!keepTaskHex.has(idHex)) continue;
      tseq += 1;
      insT.run(row.id, row.workspace_id, `task-${tseq}`, row.status ?? "todo");
    }

    const sessions = src.prepare("SELECT id, workspace_id, task_id, agent_type, agent_session_id, name, is_background, phase_order, updated_at FROM sessions").all() as Array<Record<string, unknown>>;
    const insS = dst.prepare("INSERT INTO sessions (id, workspace_id, task_id, agent_type, agent_session_id, name, is_background, phase_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    let sseq = 0;
    for (const row of sessions) {
      const taskId = row.task_id as Buffer | null;
      const taskHex = taskId ? taskId.toString("hex").toLowerCase() : "";
      if (selectedTaskIds && (!taskHex || !keepTaskHex.has(taskHex))) continue;
      sseq += 1;
      insS.run(row.id, row.workspace_id, row.task_id, row.agent_type, row.agent_session_id, `session-${sseq}`, row.is_background ?? 0, row.phase_order ?? 0, row.updated_at ?? null);
    }
  } finally {
    src.close();
    dst.close();
  }
}

function sanitizeCopilotSqlite(srcPath: string, dstPath: string): void {
  let src: Database.Database;
  try {
    src = new Database(srcPath, { readonly: true, fileMustExist: true });
  } catch {
    const dstOnly = new Database(dstPath);
    dstOnly.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT);");
    dstOnly.close();
    return;
  }
  const dst = new Database(dstPath);
  try {
    dst.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT);");
    const rows = src.prepare("SELECT id, cwd FROM sessions WHERE cwd IS NOT NULL").all() as Array<{ id: string; cwd: string }>;
    const insert = dst.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)");
    for (const row of rows) {
      insert.run(row.id, sanitizePath(row.cwd));
    }
  } catch {
    // Keep empty sanitized table when source schema is incompatible.
  } finally {
    src.close();
    dst.close();
  }
}
