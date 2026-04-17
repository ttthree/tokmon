import fs from "node:fs/promises";
import path from "node:path";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { getCodexDirectory } from "../core/config.js";
import { normalizeProjectPath } from "../core/project.js";
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

export const codexParser: Parser = {
  source: "codex",
  async parse(context: ParserContext): Promise<ParseResult> {
    const codexDir = getCodexDirectory();
    const dbPath = await findStateDatabase(codexDir);
    if (!dbPath) {
      return { sessions: [], cursorUpdates: {} };
    }

    const stat = await safeStat(dbPath);
    if (!stat?.isFile() || stat.size === 0) {
      return { sessions: [], cursorUpdates: {} };
    }

    const cursor = context.existingCursor.files[dbPath] ?? null;
    const lastUpdatedAt = shouldReuseCursor(stat, cursor) && cursor?.lastUpdatedAt
      ? Number(cursor.lastUpdatedAt)
      : 0;

    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    try {
      const rows = await db.all<CodexThreadRow[]>(
        `
          SELECT id, cwd, model, model_provider, created_at, updated_at, tokens_used, title, archived
          FROM threads
          WHERE updated_at > ? AND archived = 0
          ORDER BY updated_at ASC
        `,
        [lastUpdatedAt],
      );

      // Build token map from session files for threads that need it
      const tokenMap = await buildTokenMap(codexDir, rows.map((r) => r.id));
      const sessions = rows.map((row) => mapCodexThread(row, context.machineId, tokenMap.get(row.id)));
      const maxUpdated = await db.get<{ maxUpdatedAt: number | null }>(`SELECT MAX(updated_at) AS maxUpdatedAt FROM threads`);

      return {
        sessions,
        cursorUpdates: {
          [dbPath]: {
            path: dbPath,
            inode: Number(stat.ino),
            size: Number(stat.size),
            mtimeMs: Number(stat.mtimeMs),
            byteOffset: 0,
            lastUpdatedAt: String(maxUpdated?.maxUpdatedAt ?? lastUpdatedAt),
            processedAt: new Date().toISOString(),
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("no such table")) {
        return { sessions: [], cursorUpdates: {} };
      }
      throw error;
    } finally {
      await db.close();
    }
  },
};

async function buildTokenMap(codexDir: string, threadIds: string[]): Promise<Map<string, CodexTokenUsage>> {
  const sessionsDir = path.join(codexDir, "sessions");
  const map = new Map<string, CodexTokenUsage>();
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

      const usage = await readLastTokenUsage(file);
      if (usage) {
        map.set(threadId, usage);
      }
    }
  } catch {
    // sessions dir doesn't exist — return empty map
  }

  return map;
}

async function readLastTokenUsage(filePath: string): Promise<CodexTokenUsage | null> {
  try {
    const stat = await fs.stat(filePath);
    const fileSize = Number(stat.size);
    const handle = await fs.open(filePath, "r");
    try {
      // Search backwards in 64KB chunks for the last total_token_usage
      const CHUNK = 64 * 1024;
      let offset = Math.max(0, fileSize - CHUNK);
      let leftover = "";

      while (offset >= 0) {
        const readSize = Math.min(CHUNK, fileSize - offset);
        const buf = Buffer.alloc(readSize);
        await handle.read(buf, 0, readSize, offset);
        const chunk = buf.toString("utf8") + leftover;
        const lines = chunk.split(/\r?\n/);
        leftover = lines[0];

        for (let i = lines.length - 1; i >= 1; i--) {
          const line = lines[i];
          if (!line.includes("total_token_usage")) continue;
          try {
            const parsed = JSON.parse(line) as { payload?: { info?: { total_token_usage?: CodexTokenUsage } } };
            const usage = parsed?.payload?.info?.total_token_usage;
            if (usage && typeof usage.input_tokens === "number") {
              return usage;
            }
          } catch { /* malformed */ }
        }

        if (offset === 0) break;
        offset = Math.max(0, offset - CHUNK);
      }
    } finally {
      await handle.close();
    }
  } catch {
    // file not readable
  }
  return null;
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

function mapCodexThread(row: CodexThreadRow, machineId: string, usage?: CodexTokenUsage): Session {
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

  const tokens: TokenBreakdown = usage
    ? {
        input: numberOrZero(usage.input_tokens) - numberOrZero(usage.cached_input_tokens),
        output: numberOrZero(usage.output_tokens),
        cacheCreation: 0,
        cacheRead: numberOrZero(usage.cached_input_tokens),
      }
    : { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

  return {
    id: row.id,
    machineId,
    source: "codex",
    projectPath,
    project: path.basename(normalizeProjectPath(projectPath)) || "other",
    summary: row.title ?? undefined,
    model,
    createdAt,
    modifiedAt,
    durationSeconds: Math.max(0, row.updated_at - row.created_at),
    turns: 0,
    messageCount: 0,
    toolCallCount: 0,
    tokens,
    cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
    toolBreakdown: {},
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
