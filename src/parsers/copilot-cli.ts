import fs from "node:fs/promises";
import path from "node:path";

import { getCopilotDirectory } from "../core/config.js";
import { normalizeProjectPath } from "../core/project.js";
import type { FileCursor, ParseResult, Parser, ParserContext, Session, TokenBreakdown } from "../core/types.js";

export interface CopilotModelCall {
  api_id: string;
  model: string;
  interaction_id?: string;
  session_id?: string;
  copilot_pid?: string;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_count?: number;
  completion_tokens_count?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  duration?: number;
  timestamp?: string;
  projectPath?: string;
}

interface ParsedEvent {
  call: CopilotModelCall;
  timestamp: string;
}

interface SessionAccumulator {
  id: string;
  projectPath: string;
  model: string;
  createdAt: number;
  modifiedAt: number;
  apiIds: Set<string>;
  durationSeconds: number;
  tokens: TokenBreakdown;
}

export const copilotCliParser: Parser = {
  source: "copilot-cli",
  async parse(context: ParserContext): Promise<ParseResult> {
    const logsDir = path.join(getCopilotDirectory(), "logs");
    const files = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => []);
    const logFiles = files.filter((entry) => entry.isFile() && /^process-.*\.log$/.test(entry.name)).map((entry) => path.join(logsDir, entry.name)).sort();

    const sessionsByKey = new Map<string, Session>();
    const cursorUpdates: Record<string, FileCursor> = {};

    for (const filePath of logFiles) {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }

      const cursor = context.existingCursor.files[filePath] ?? null;
      if (cursor && cursor.inode === Number(stat.ino) && cursor.size === stat.size && cursor.mtimeMs === stat.mtimeMs) {
        continue;
      }

      const fileSessions = await parseCopilotLogFile(filePath, context.machineId);
      for (const session of fileSessions) {
        const key = `${session.source}:${session.id}`;
        const existing = sessionsByKey.get(key);
        sessionsByKey.set(key, existing ? mergeSessions(existing, session) : session);
      }
      cursorUpdates[filePath] = {
        path: filePath,
        inode: Number(stat.ino),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        byteOffset: stat.size,
        processedAt: new Date().toISOString(),
      };
    }

    return {
      sessions: [...sessionsByKey.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      cursorUpdates,
    };
  },
};

function mergeSessions(existing: Session, incoming: Session): Session {
  return {
    ...existing,
    projectPath: existing.projectPath || incoming.projectPath,
    project: existing.project !== "other" ? existing.project : incoming.project,
    model: existing.model !== "unknown" ? existing.model : incoming.model,
    createdAt: existing.createdAt < incoming.createdAt ? existing.createdAt : incoming.createdAt,
    modifiedAt: existing.modifiedAt > incoming.modifiedAt ? existing.modifiedAt : incoming.modifiedAt,
    durationSeconds: existing.durationSeconds + incoming.durationSeconds,
    turns: existing.turns + incoming.turns,
    messageCount: existing.messageCount + incoming.messageCount,
    toolCallCount: existing.toolCallCount + incoming.toolCallCount,
    tokens: {
      input: existing.tokens.input + incoming.tokens.input,
      output: existing.tokens.output + incoming.tokens.output,
      cacheCreation: existing.tokens.cacheCreation + incoming.tokens.cacheCreation,
      cacheRead: existing.tokens.cacheRead + incoming.tokens.cacheRead,
    },
    cost: {
      input: existing.cost.input + incoming.cost.input,
      output: existing.cost.output + incoming.cost.output,
      cacheCreation: existing.cost.cacheCreation + incoming.cost.cacheCreation,
      cacheRead: existing.cost.cacheRead + incoming.cost.cacheRead,
      total: existing.cost.total + incoming.cost.total,
    },
    toolBreakdown: {
      ...existing.toolBreakdown,
      ...incoming.toolBreakdown,
    },
  };
}

export function normalizeTokens(call: CopilotModelCall): { input: number; output: number } {
  return {
    input: numberOrZero(call.input_tokens ?? call.prompt_tokens_count),
    output: numberOrZero(call.output_tokens ?? call.completion_tokens_count),
  };
}

async function parseCopilotLogFile(filePath: string, machineId: string): Promise<Session[]> {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!content) {
    return [];
  }
  const fallbackTimestamp = (await fs.stat(filePath).catch(() => null))?.mtime.toISOString() ?? new Date().toISOString();
  const events = parseEvents(content, fallbackTimestamp);
  return aggregateEvents(events, machineId);
}

function parseEvents(content: string, fallbackTimestamp: string): ParsedEvent[] {
  const lines = content.split(/\r?\n/);
  const events: ParsedEvent[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("assistant_usage") && !line.includes("cli.model_call:")) {
      continue;
    }

    const extracted = extractJsonBlock(lines, index);
    if (!extracted) {
      continue;
    }
    const raw = parseJsonSafe(extracted.jsonText);
    if (!raw) {
      index = extracted.nextIndex - 1;
      continue;
    }
    const call = normalizeRecord(raw, line);
    if (!call) {
      index = extracted.nextIndex - 1;
      continue;
    }

    events.push({ call: { ...call, timestamp: extractTimestamp(line) ?? fallbackTimestamp }, timestamp: extractTimestamp(line) ?? fallbackTimestamp });
    index = extracted.nextIndex - 1;
  }

  return events;
}

function aggregateEvents(events: ParsedEvent[], machineId: string): Session[] {
  const grouped = new Map<string, SessionAccumulator>();

  for (const event of events) {
    const id = resolveSessionKey(event.call);
    const timestamp = Date.parse(event.timestamp);
    const tokens = normalizeTokens(event.call);
    const existing = grouped.get(id);
    if (!existing) {
      grouped.set(id, {
        id,
        projectPath: inferProjectPath(event.call) ?? "",
        model: event.call.model || "unknown",
        createdAt: Number.isNaN(timestamp) ? Date.now() : timestamp,
        modifiedAt: Number.isNaN(timestamp) ? Date.now() : timestamp,
        apiIds: new Set([event.call.api_id]),
        durationSeconds: numberOrZero(event.call.duration) / 1000,
        tokens: {
          input: tokens.input,
          output: tokens.output,
          cacheCreation: numberOrZero(event.call.cache_write_tokens),
          cacheRead: numberOrZero(event.call.cache_read_tokens),
        },
      });
      continue;
    }

    existing.createdAt = Math.min(existing.createdAt, timestamp);
    existing.modifiedAt = Math.max(existing.modifiedAt, timestamp);
    existing.model = existing.model === "unknown" ? event.call.model : existing.model;
    existing.apiIds.add(event.call.api_id);
    existing.durationSeconds += numberOrZero(event.call.duration) / 1000;
    existing.tokens.input += tokens.input;
    existing.tokens.output += tokens.output;
    existing.tokens.cacheCreation += numberOrZero(event.call.cache_write_tokens);
    existing.tokens.cacheRead += numberOrZero(event.call.cache_read_tokens);
    if (!existing.projectPath) {
      existing.projectPath = inferProjectPath(event.call) ?? existing.projectPath;
    }
  }

  return [...grouped.values()].map((acc) => ({
    id: acc.id,
    machineId,
    source: "copilot-cli",
    projectPath: acc.projectPath,
    project: path.basename(normalizeProjectPath(acc.projectPath)) || "other",
    model: acc.model,
    createdAt: new Date(acc.createdAt).toISOString(),
    modifiedAt: new Date(acc.modifiedAt).toISOString(),
    durationSeconds: acc.durationSeconds,
    turns: acc.apiIds.size,
    messageCount: acc.apiIds.size,
    toolCallCount: 0,
    tokens: acc.tokens,
    cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    toolBreakdown: {},
  }));
}

function normalizeRecord(raw: Record<string, unknown>, line: string): CopilotModelCall | null {
  return parseStructuredRecord(raw, line) ?? parseInlineRecord(raw, line);
}

function parseStructuredRecord(raw: Record<string, unknown>, line: string): CopilotModelCall | null {
  if (!(raw.kind === "assistant_usage" || line.includes("assistant_usage"))) {
    return null;
  }
  const properties = isRecord(raw.properties) ? raw.properties : {};
  const metrics = isRecord(raw.metrics) ? raw.metrics : {};
  const apiId = stringOrUndefined(properties.event_id) ?? stringOrUndefined(raw.api_id) ?? stringOrUndefined(raw.event_id);
  const model = stringOrUndefined(properties.model) ?? stringOrUndefined(raw.model);
  if (!apiId || !model) {
    return null;
  }
  return {
    api_id: apiId,
    model,
    interaction_id: stringOrUndefined(properties.interaction_id) ?? stringOrUndefined(raw.interaction_id),
    session_id: stringOrUndefined(raw.session_id),
    copilot_pid: stringOrUndefined(properties.copilot_pid) ?? stringOrUndefined(raw.copilot_pid),
    input_tokens: numberOrUndefined(metrics.input_tokens),
    output_tokens: numberOrUndefined(metrics.output_tokens),
    cache_read_tokens: numberOrUndefined(metrics.cache_read_tokens),
    cache_write_tokens: numberOrUndefined(metrics.cache_write_tokens),
    duration: numberOrUndefined(metrics.duration),
    timestamp: stringOrUndefined(raw.timestamp),
    projectPath: inferProjectPath(raw) ?? inferProjectPath(properties) ?? undefined,
  };
}

function parseInlineRecord(raw: Record<string, unknown>, line: string): CopilotModelCall | null {
  if (!(line.includes("cli.model_call:") || raw.api_id !== undefined || raw.prompt_tokens_count !== undefined)) {
    return null;
  }
  const apiId = stringOrUndefined(raw.api_id) ?? stringOrUndefined(raw.event_id) ?? stringOrUndefined(raw.id);
  const model = stringOrUndefined(raw.model);
  if (!apiId || !model) {
    return null;
  }
  return {
    api_id: apiId,
    model,
    interaction_id: stringOrUndefined(raw.interaction_id),
    session_id: stringOrUndefined(raw.session_id),
    copilot_pid: stringOrUndefined(raw.copilot_pid),
    prompt_tokens_count: numberOrUndefined(raw.prompt_tokens_count),
    completion_tokens_count: numberOrUndefined(raw.completion_tokens_count),
    cache_read_tokens: numberOrUndefined(raw.cache_read_tokens),
    cache_write_tokens: numberOrUndefined(raw.cache_write_tokens),
    duration: numberOrUndefined(raw.duration),
    timestamp: stringOrUndefined(raw.timestamp),
    projectPath: inferProjectPath(raw) ?? undefined,
  };
}

function resolveSessionKey(call: CopilotModelCall): string {
  return call.interaction_id ?? call.session_id ?? call.copilot_pid ?? call.api_id;
}

function inferProjectPath(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidates = [value.projectPath, value.project_path, value.cwd, value.workdir, value.workspace, value.workspace_path, value.repo_path];
  for (const candidate of candidates) {
    const text = stringOrUndefined(candidate);
    if (text) {
      return text;
    }
  }
  if (isRecord(value.properties)) {
    return inferProjectPath(value.properties);
  }
  if (isRecord(value.context)) {
    return inferProjectPath(value.context);
  }
  return null;
}

function extractJsonBlock(lines: string[], startIndex: number): { jsonText: string; nextIndex: number } | null {
  let started = false;
  let depth = 0;
  let inString = false;
  let escape = false;
  let buffer = "";

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    for (const char of line) {
      if (!started) {
        if (char !== "{") {
          continue;
        }
        started = true;
        depth = 1;
        buffer += char;
        continue;
      }
      buffer += char;
      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === "\\") {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return { jsonText: buffer, nextIndex: index + 1 };
        }
      }
    }
    if (started) {
      buffer += "\n";
    }
  }
  return null;
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractTimestamp(line: string): string | null {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
