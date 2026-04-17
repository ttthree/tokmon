import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { getCodexDirectory } from "../core/config.js";
import { computeActiveDurationSeconds } from "../core/duration.js";
import { normalizeProjectPath } from "../core/project.js";
import { marsRegistry } from "./mars.js";
import { applyMarsMeta } from "./orchestrator.js";
import type { FileCursor, ParseResult, Parser, ParserContext, Session, TokenBreakdown } from "../core/types.js";

interface CodexThreadRow {
  id: string;
  cwd: string;
  model: string | null;
  model_provider: string | null;
  created_at: number;
  updated_at: number;
  tokens_used: number;
  title: string | null;
  archived: number;
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexRolloutStats {
  usage?: CodexTokenUsage;
  turns: number;
  messageCount: number;
  toolCallCount: number;
  toolBreakdown: Record<string, number>;
  firstEventAt?: number;
  lastEventAt?: number;
  firstPrompt?: string;
  eventTimestampsMs: number[];
}

export const codexParser: Parser = {
  source: "codex",
  async parse(context: ParserContext): Promise<ParseResult> {
    const enabledCodex = (context.sources ?? []).filter((s) => s.enabled && s.type === "codex").map((s) => s.path);
    const roots = [
      ...(enabledCodex.length > 0 ? enabledCodex : [getCodexDirectory()]),
      ...marsRegistry.codexRoots,
    ];
    const sessionsByKey = new Map<string, Session>();
    const cursorUpdates: Record<string, FileCursor> = {};

    for (const codexDir of roots) {
      const dbPath = await findStateDatabase(codexDir);
      if (!dbPath) continue;

      const stat = await safeStat(dbPath);
      if (!stat?.isFile() || stat.size === 0) continue;

      const cursor = context.existingCursor.files[dbPath] ?? null;
      const lastUpdatedAt = shouldReuseCursor(stat, cursor) && cursor?.lastUpdatedAt
        ? Number(cursor.lastUpdatedAt)
        : 0;

      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const columns = new Set(
          (db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name: string }>).map((c) => c.name),
        );
        if (columns.size === 0) {
          // `threads` table doesn't exist in this database; skip.
          continue;
        }

        const wanted = ["id", "cwd", "model", "model_provider", "created_at", "updated_at", "tokens_used", "title", "archived"];
        const selectExprs = wanted.map((col) => (columns.has(col) ? col : `NULL AS ${col}`)).join(", ");
        const hasUpdatedAt = columns.has("updated_at");
        const hasArchived = columns.has("archived");
        const orderBy = hasUpdatedAt ? "ORDER BY updated_at ASC" : "";
        const whereClauses: string[] = [];
        if (hasUpdatedAt) whereClauses.push("updated_at > ?");
        if (hasArchived) whereClauses.push("archived = 0");
        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
        const params = hasUpdatedAt ? [lastUpdatedAt] : [];

        const rows = db.prepare(`SELECT ${selectExprs} FROM threads ${whereSql} ${orderBy}`).all(...params) as CodexThreadRow[];

        const statsMap = await buildRolloutStatsMap(codexDir, rows.map((r) => r.id));
        for (const row of rows) {
          let session = mapCodexThread(row, context.machineId, statsMap.get(row.id));
          const marsMeta = marsRegistry.byAgentSessionId.codex.get(session.id);
          if (marsMeta) {
            session = applyMarsMeta(session, marsMeta, "codex");
          }
          const key = `${session.source}:${session.id}`;
          const existing = sessionsByKey.get(key);
          if (!existing || existing.modifiedAt < session.modifiedAt) {
            sessionsByKey.set(key, session);
          }
        }
        const maxUpdated = hasUpdatedAt
          ? (db.prepare(`SELECT MAX(updated_at) AS maxUpdatedAt FROM threads`).get() as { maxUpdatedAt: number | null } | undefined)
          : undefined;
        cursorUpdates[dbPath] = {
          path: dbPath,
          inode: Number(stat.ino),
          size: Number(stat.size),
          mtimeMs: Number(stat.mtimeMs),
          byteOffset: 0,
          lastUpdatedAt: String(maxUpdated?.maxUpdatedAt ?? lastUpdatedAt),
          processedAt: new Date().toISOString(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("no such table") && !message.includes("no such column")) {
          throw error;
        }
      } finally {
        db.close();
      }
    }

    return {
      sessions: [...sessionsByKey.values()],
      cursorUpdates,
    };
  },
};

async function buildRolloutStatsMap(codexDir: string, threadIds: string[]): Promise<Map<string, CodexRolloutStats>> {
  const sessionsDir = path.join(codexDir, "sessions");
  const map = new Map<string, CodexRolloutStats>();
  const needed = new Set(threadIds);
  if (needed.size === 0) return map;

  try {
    const files = await walkJsonlFiles(sessionsDir);
    for (const file of files) {
      // Filename: rollout-YYYY-MM-DDTHH-MM-SS-{threadId}.jsonl
      const match = path.basename(file).match(/rollout-[\d-T]+-(.+)\.jsonl$/);
      if (!match) continue;
      const threadId = match[1];
      if (!needed.has(threadId)) continue;

      const stats = await readRolloutStats(file);
      if (stats) {
        map.set(threadId, stats);
      }
    }
  } catch {
    // sessions dir doesn't exist — return empty map
  }

  return map;
}

async function readRolloutStats(filePath: string): Promise<CodexRolloutStats | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const stats: CodexRolloutStats = {
      turns: 0,
      messageCount: 0,
      toolCallCount: 0,
      toolBreakdown: {},
      eventTimestampsMs: [],
    };

    // Track function_call → function_call_output pairing by call_id.
    // Codex re-emits function_call entries across turns; count each unique call_id once.
    const seenCallIds = new Set<string>();

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: CodexRolloutLine;
      try {
        parsed = JSON.parse(line) as CodexRolloutLine;
      } catch { continue; }

      const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
      if (Number.isFinite(ts)) {
        if (stats.firstEventAt === undefined) stats.firstEventAt = ts;
        stats.lastEventAt = ts;
        stats.eventTimestampsMs.push(ts);
      }

      const type = parsed.type;
      const payload = parsed.payload as CodexRolloutPayload | undefined;
      if (!payload) continue;

      if (type === "event_msg") {
        if (payload.type === "token_count") {
          const usage = payload.info?.total_token_usage;
          if (usage && typeof usage.input_tokens === "number") {
            stats.usage = usage;
          }
        } else if (payload.type === "user_message" && typeof payload.message === "string") {
          stats.turns += 1;
          stats.messageCount += 1;
          if (!stats.firstPrompt) {
            stats.firstPrompt = truncatePrompt(payload.message);
          }
        } else if (payload.type === "agent_message" && typeof payload.message === "string") {
          stats.messageCount += 1;
        }
      } else if (type === "response_item") {
        if (payload.type === "function_call") {
          const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
          if (callId && seenCallIds.has(callId)) continue;
          if (callId) seenCallIds.add(callId);
          const name = typeof payload.name === "string" ? payload.name : "tool";
          stats.toolCallCount += 1;
          stats.toolBreakdown[name] = (stats.toolBreakdown[name] ?? 0) + 1;
        }
      }
    }

    return stats;
  } catch {
    return null;
  }
}

function truncatePrompt(value: string, max = 500): string {
  const cleaned = value.trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + "…";
}

interface CodexRolloutLine {
  timestamp?: string;
  type?: string;
  payload?: CodexRolloutPayload;
}

interface CodexRolloutPayload {
  type?: string;
  message?: string;
  info?: { total_token_usage?: CodexTokenUsage };
  name?: string;
  call_id?: string;
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }
  await walk(dir);
  return files;
}

async function findStateDatabase(codexDir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(codexDir);
    const stateFiles = entries
      .filter(e => /^state_\d+\.sqlite$/.test(e))
      .sort((a, b) => {
        const numA = parseInt(a.match(/state_(\d+)/)?.[1] ?? "0", 10);
        const numB = parseInt(b.match(/state_(\d+)/)?.[1] ?? "0", 10);
        return numB - numA;
      });
    if (stateFiles.length === 0) {
      return null;
    }
    return path.join(codexDir, stateFiles[0]);
  } catch {
    return null;
  }
}

function mapCodexThread(row: CodexThreadRow, machineId: string, stats?: CodexRolloutStats): Session {
  const projectPath = row.cwd ?? "";
  const createdAt = new Date(row.created_at * 1000).toISOString();
  const modifiedAt = new Date(row.updated_at * 1000).toISOString();

  const model = row.model
    ? row.model_provider
      ? `${row.model} (${row.model_provider})`
      : row.model
    : row.model_provider
      ? `codex (${row.model_provider})`
      : "unknown";

  const usage = stats?.usage;
  const tokens: TokenBreakdown = usage
    ? {
        input: numberOrZero(usage.input_tokens) - numberOrZero(usage.cached_input_tokens),
        output: numberOrZero(usage.output_tokens),
        cacheCreation: 0,
        cacheRead: numberOrZero(usage.cached_input_tokens),
      }
    : { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

  // Active duration = sum of inter-event gaps capped at the idle threshold.
  // Wall-clock (lastEvent - firstEvent) inflates when sessions are left open
  // idle for long stretches.
  const activeFromEvents = stats?.eventTimestampsMs?.length
    ? computeActiveDurationSeconds(stats.eventTimestampsMs)
    : 0;
  const durationSeconds = activeFromEvents;

  return {
    id: row.id,
    machineId,
    source: "codex",
    engine: "Codex",
    projectPath,
    project: path.basename(normalizeProjectPath(projectPath)) || "other",
    summary: row.title ?? undefined,
    firstPrompt: stats?.firstPrompt,
    model,
    createdAt,
    modifiedAt,
    durationSeconds,
    turns: stats?.turns ?? 0,
    messageCount: stats?.messageCount ?? 0,
    toolCallCount: stats?.toolCallCount ?? 0,
    tokens,
    cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    toolBreakdown: stats?.toolBreakdown ?? {},
  };
}

async function safeStat(target: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function shouldReuseCursor(stat: Awaited<ReturnType<typeof fs.stat>>, cursor: FileCursor | null): boolean {
  return Boolean(cursor && cursor.inode === Number(stat.ino) && stat.size >= cursor.size && stat.mtimeMs >= cursor.mtimeMs);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
