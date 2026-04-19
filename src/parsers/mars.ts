import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { getMarsAppSupportDirectories } from "../core/config.js";
import { logDiag } from "../core/diag-log.js";
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
    const usedConfigured = enabledMars.length > 0;
    const appSupportDirs = usedConfigured ? enabledMars : getMarsAppSupportDirectories();

    void logDiag({
      event: "mars.parse.start",
      usedConfiguredSources: usedConfigured,
      appSupportDirs,
      appSupportDirCount: appSupportDirs.length,
    });

    for (const appDir of appSupportDirs) {
      await maybeAddRoot(path.join(appDir, "agent-configs", "claude"), marsRegistry.claudeRoots);
      await maybeAddRoot(path.join(appDir, "agent-configs", "codex"), marsRegistry.codexRoots);
      await maybeAddRoot(path.join(appDir, "agent-configs", "copilot"), marsRegistry.copilotRoots);
    }

    let totalRowsLoaded = 0;
    for (const appDir of appSupportDirs) {
      const dbPath = path.join(appDir, "marsiwe.db");
      const stat = await safeStat(dbPath);
      if (!stat?.isFile()) {
        void logDiag({ event: "mars.db.skip", dbPath, reason: "not-a-file", existed: stat !== null });
        continue;
      }
      const loadResult = await loadMarsRows(dbPath);
      void logDiag({
        event: "mars.db.load",
        dbPath,
        sizeBytes: stat.size,
        outcome: loadResult.outcome,
        rowCount: loadResult.rows.length,
        errorCode: loadResult.errorCode,
        errorMessage: loadResult.errorMessage,
      });
      totalRowsLoaded += loadResult.rows.length;
      let validRows = 0;
      let droppedNoAgentSession = 0;
      let droppedNoMarsId = 0;
      let droppedUnknownAgentType = 0;
      for (const row of loadResult.rows) {
        const agentType = normalizeMarsAgentType(stringOrUndefined(row.agent_type_raw) ?? "");
        const agentSessionId = typeof row.agent_session_id === "string" ? row.agent_session_id.trim() : "";
        const marsSessionId = stringOrUndefined(row.mars_session_id);
        if (!agentType) { droppedUnknownAgentType++; continue; }
        if (!agentSessionId) { droppedNoAgentSession++; continue; }
        if (!marsSessionId) { droppedNoMarsId++; continue; }
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
        validRows++;
      }
      void logDiag({
        event: "mars.db.upsert",
        dbPath,
        validRows,
        droppedNoAgentSession,
        droppedNoMarsId,
        droppedUnknownAgentType,
      });
    }

    void logDiag({
      event: "mars.parse.done",
      totalRowsLoaded,
      registry: {
        claudeCode: marsRegistry.byAgentSessionId.claudeCode.size,
        codex: marsRegistry.byAgentSessionId.codex.size,
        copilotCli: marsRegistry.byAgentSessionId.copilotCli.size,
      },
    });

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

interface LoadResult {
  rows: Array<Record<string, unknown>>;
  outcome: "ok" | "open-failed" | "query-failed" | "schema-mismatch";
  errorCode?: string;
  errorMessage?: string;
}

async function loadMarsRows(dbPath: string): Promise<LoadResult> {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    return {
      rows: [],
      outcome: "open-failed",
      errorCode: errorCodeOf(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const rows = db.prepare(`
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
    return { rows, outcome: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("no such table") || message.includes("file is not a database")) {
      return { rows: [], outcome: "schema-mismatch", errorMessage: message };
    }
    return {
      rows: [],
      outcome: "query-failed",
      errorCode: errorCodeOf(error),
      errorMessage: message,
    };
  } finally {
    db.close();
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
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
