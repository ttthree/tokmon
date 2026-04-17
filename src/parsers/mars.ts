import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { getMarsAppSupportDirectories } from "../core/config.js";
import type { ParseResult, Parser, ParserContext } from "../core/types.js";

type MarsAgentType = "claude-code" | "codex" | "copilot-cli";

export interface MarsSessionMeta {
  marsSessionId: string;
  agentSessionId: string;
  agentType: MarsAgentType;
  sessionName?: string;
  phaseOrder?: number;
  isBackground: boolean;
  taskId?: string;
  taskTitle?: string;
  taskStatus?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  updatedAt?: string;
}

export interface MarsRegistry {
  claudeRoots: string[];
  codexRoots: string[];
  copilotRoots: string[];
  byAgentSessionId: {
    claudeCode: Map<string, MarsSessionMeta>;
    codex: Map<string, MarsSessionMeta>;
    copilotCli: Map<string, MarsSessionMeta>;
  };
}

export let marsRegistry: MarsRegistry = createEmptyMarsRegistry();

export function resetMarsRegistry(): void {
  marsRegistry = createEmptyMarsRegistry();
}

export const marsParser: Parser = {
  source: "mars",
  async parse(context: ParserContext): Promise<ParseResult> {
    resetMarsRegistry();
    const enabledMars = (context.sources ?? []).filter((s) => s.enabled && s.type === "mars").map((s) => s.path);
    const appSupportDirs = enabledMars.length > 0 ? enabledMars : getMarsAppSupportDirectories();

    for (const appDir of appSupportDirs) {
      await maybeAddRoot(path.join(appDir, "agent-configs", "claude"), marsRegistry.claudeRoots);
      await maybeAddRoot(path.join(appDir, "agent-configs", "codex"), marsRegistry.codexRoots);
      await maybeAddRoot(path.join(appDir, "agent-configs", "copilot"), marsRegistry.copilotRoots);
    }

    for (const appDir of appSupportDirs) {
      const dbPath = path.join(appDir, "marsiwe.db");
      const stat = await safeStat(dbPath);
      if (!stat?.isFile()) continue;
      const rows = await loadMarsRows(dbPath);
      for (const row of rows) {
        const agentType = normalizeMarsAgentType(stringOrUndefined(row.agent_type_raw) ?? "");
        const agentSessionId = typeof row.agent_session_id === "string" ? row.agent_session_id.trim() : "";
        const marsSessionId = stringOrUndefined(row.mars_session_id);
        if (!agentType || !agentSessionId) continue;
        if (!marsSessionId) continue;
        const meta: MarsSessionMeta = {
          marsSessionId,
          agentSessionId,
          agentType,
          sessionName: stringOrUndefined(row.session_name),
          phaseOrder: numberOrUndefined(row.phase_order),
          isBackground: Boolean(row.is_background),
          taskId: stringOrUndefined(row.task_id),
          taskTitle: stringOrUndefined(row.task_title),
          taskStatus: stringOrUndefined(row.task_status),
          workspaceId: stringOrUndefined(row.workspace_id),
          workspaceName: stringOrUndefined(row.workspace_name),
          workspacePath: stringOrUndefined(row.workspace_path),
          updatedAt: stringOrUndefined(row.session_updated_at),
        };
        upsertMeta(meta);
      }
    }

    return { sessions: [], cursorUpdates: {} };
  },
};

function createEmptyMarsRegistry(): MarsRegistry {
  return {
    claudeRoots: [],
    codexRoots: [],
    copilotRoots: [],
    byAgentSessionId: {
      claudeCode: new Map(),
      codex: new Map(),
      copilotCli: new Map(),
    },
  };
}

function normalizeMarsAgentType(raw: string): MarsAgentType | null {
  const s = raw.toLowerCase().replace(/[_-]/g, "");
  if (s.startsWith("claude")) return "claude-code";
  if (s.startsWith("codex")) return "codex";
  if (s.startsWith("copilot")) return "copilot-cli";
  return null;
}

async function loadMarsRows(dbPath: string): Promise<Array<Record<string, unknown>>> {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    return db.prepare(`
      SELECT
        lower(hex(s.id)) AS mars_session_id,
        s.agent_session_id AS agent_session_id,
        s.agent_type AS agent_type_raw,
        s.name AS session_name,
        s.is_background AS is_background,
        s.phase_order AS phase_order,
        s.updated_at AS session_updated_at,
        lower(hex(t.id)) AS task_id,
        t.title AS task_title,
        t.status AS task_status,
        lower(hex(w.id)) AS workspace_id,
        w.name AS workspace_name,
        w.path AS workspace_path
      FROM sessions s
      LEFT JOIN tasks t ON s.task_id = t.id
      LEFT JOIN workspaces w ON s.workspace_id = w.id
      WHERE s.agent_session_id IS NOT NULL
    `).all() as Array<Record<string, unknown>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("no such table") || message.includes("file is not a database")) return [];
    throw error;
  } finally {
    db.close();
  }
}

function upsertMeta(meta: MarsSessionMeta): void {
  const map = meta.agentType === "claude-code"
    ? marsRegistry.byAgentSessionId.claudeCode
    : meta.agentType === "codex"
      ? marsRegistry.byAgentSessionId.codex
      : marsRegistry.byAgentSessionId.copilotCli;
  const existing = map.get(meta.agentSessionId);
  if (!existing || rankUpdatedAt(meta.updatedAt) >= rankUpdatedAt(existing.updatedAt)) {
    map.set(meta.agentSessionId, meta);
  }
}

function rankUpdatedAt(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

async function maybeAddRoot(dir: string, roots: string[]): Promise<void> {
  const stat = await safeStat(dir);
  if (stat?.isDirectory()) roots.push(dir);
}

async function safeStat(target: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
