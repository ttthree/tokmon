import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { getHomeDirectory } from "../../../core/config.js";
import type { SourceEntry } from "../../../core/types.js";

export type SourceCategory = "claude-code" | "claude-code-craft" | "eureka-claude" | "eureka-codex" | "codex" | "copilot-cli";

export interface DiscoveredSession {
  sessionId: string;
  sourceCategory: SourceCategory;
  primaryFile: string;
  auxFiles: string[];
  headerInfo?: {
    engine?: string;
    sdkSessionId?: string;
    sdkCwd?: string;
  };
}

export async function discoverSessions(sourceEntries: SourceEntry[]): Promise<DiscoveredSession[]> {
  const eurekaEntries = sourceEntries.filter((s) => s.enabled && s.type === "eureka");
  const claudeEntries = sourceEntries.filter((s) => s.enabled && s.type === "claude-code");
  const codexEntries = sourceEntries.filter((s) => s.enabled && s.type === "codex");
  const copilotEntries = sourceEntries.filter((s) => s.enabled && s.type === "copilot-cli");

  const eureka = await discoverEureka(eurekaEntries);
  const claimed = new Set(eureka.map((s) => s.headerInfo?.sdkSessionId).filter((v): v is string => Boolean(v)));
  const claude = await discoverClaude(claudeEntries, claimed);
  const codex = await discoverCodex(codexEntries);
  const copilot = await discoverCopilot(copilotEntries);

  return [...eureka, ...claude, ...codex, ...copilot];
}

async function discoverEureka(entries: SourceEntry[]): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];
  for (const entry of entries) {
    const workspaces = await fs.readdir(entry.path, { withFileTypes: true }).catch(() => []);
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const sessionsDir = path.join(entry.path, workspace.name, "sessions");
      const sessionDirs = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;
        const root = path.join(sessionsDir, sessionDir.name);
        const sessionJsonl = path.join(root, "session.jsonl");
        const telemetry = path.join(root, "llm-telemetry.jsonl");
        const sessionStat = await statFile(sessionJsonl);
        const telemetryStat = await statFile(telemetry);
        if (!sessionStat && !telemetryStat) continue;

        const header = await readEurekaHeader(sessionJsonl);
        const sourceCategory: SourceCategory = String(header.engine ?? "").toLowerCase().includes("codex") ? "eureka-codex" : "eureka-claude";
        const primary = telemetryStat ? telemetry : sessionJsonl;
        const aux = [sessionStat ? sessionJsonl : null, telemetryStat ? telemetry : null].filter((v): v is string => Boolean(v) && v !== primary);

        if (header.sdkSessionId) {
          const linked = await discoverEurekaLinkedFiles(root, sourceCategory, header.sdkSessionId, header.sdkCwd);
          aux.push(...linked);
        }

        sessions.push({
          sessionId: sessionDir.name,
          sourceCategory,
          primaryFile: primary,
          auxFiles: unique(aux),
          headerInfo: header,
        });
      }
    }
  }
  return sessions;
}

async function discoverClaude(entries: SourceEntry[], claimed: Set<string>): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];
  for (const entry of entries) {
    const root = path.join(entry.path, "projects");
    const files = await walkFiles(root, (f) => f.endsWith(".jsonl"));
    const craft = entry.path.includes(`${path.sep}.craft-agent${path.sep}.claude`) || entry.path.includes(`${path.sep}.eureka${path.sep}.claude`);
    for (const file of files) {
      const sid = path.basename(file, ".jsonl");
      if (craft && (claimed.has(sid) || claimed.has(path.basename(path.dirname(path.dirname(file)))))) continue;
      const aux: string[] = [];
      if (path.basename(path.dirname(file)) !== "subagents") {
        const subDir = path.join(path.dirname(file), sid, "subagents");
        aux.push(...await walkFiles(subDir, (f) => f.endsWith(".jsonl")));
      }
      sessions.push({
        sessionId: sid,
        sourceCategory: craft ? "claude-code-craft" : "claude-code",
        primaryFile: file,
        auxFiles: unique(aux),
      });
    }
  }
  return sessions;
}

async function discoverCodex(entries: SourceEntry[]): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];
  for (const entry of entries) {
    const dbPath = await findStateDatabase(entry.path);
    if (!dbPath) continue;
    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      continue;
    }
    try {
      const rows = db.prepare("SELECT id FROM threads WHERE archived = 0").all() as Array<{ id: string }>;
      const rollouts = await walkFiles(path.join(entry.path, "sessions"), (f) => f.endsWith(".jsonl"));
      for (const row of rows) {
        const rollout = rollouts.find((f) => f.endsWith(`-${row.id}.jsonl`));
        sessions.push({
          sessionId: row.id,
          sourceCategory: "codex",
          primaryFile: rollout ?? dbPath,
          auxFiles: unique([dbPath, ...(rollout ? [rollout] : [])]),
        });
      }
    } finally {
      db.close();
    }
  }
  return sessions;
}

async function discoverCopilot(entries: SourceEntry[]): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];
  for (const entry of entries) {
    const logs = await walkFiles(path.join(entry.path, "logs"), (f) => /^process-.*\.log$/.test(path.basename(f)));
    const sessionStore = path.join(entry.path, "session-store.db");
    const hasSessionStore = await statFile(sessionStore);
    for (const file of logs) {
      sessions.push({
        sessionId: path.basename(file),
        sourceCategory: "copilot-cli",
        primaryFile: file,
        auxFiles: hasSessionStore ? [sessionStore] : [],
      });
    }
  }
  return sessions;
}

async function discoverEurekaLinkedFiles(sessionRoot: string, sourceCategory: SourceCategory, sdkSessionId: string, sdkCwd?: string): Promise<string[]> {
  const linked: string[] = [];
  if (sourceCategory === "eureka-codex") {
    const codexFiles = await walkFiles(path.join(sessionRoot, ".codex-home", "sessions"), (f) => f.endsWith(".jsonl") && path.basename(f).includes(sdkSessionId));
    linked.push(...codexFiles);
    return linked;
  }

  if (!sdkCwd) return linked;
  const encoded = sdkCwd.replace(/[/.]/g, "-");
  for (const base of [".craft-agent", ".eureka"]) {
    const ccDir = path.join(getHomeDirectory(), base, ".claude", "projects", encoded);
    const mainFile = path.join(ccDir, `${sdkSessionId}.jsonl`);
    if (await statFile(mainFile)) linked.push(mainFile);
    const subagents = await walkFiles(path.join(ccDir, sdkSessionId, "subagents"), (f) => f.endsWith(".jsonl"));
    linked.push(...subagents);
  }
  return linked;
}

async function readEurekaHeader(sessionJsonlPath: string): Promise<{ engine?: string; sdkSessionId?: string; sdkCwd?: string }> {
  const raw = await fs.readFile(sessionJsonlPath, "utf8").catch(() => "");
  const line = raw.split(/\r?\n/)[0];
  if (!line.trim()) return {};
  try {
    const parsed = JSON.parse(line) as { engine?: unknown; sdkSessionId?: unknown; sdkCwd?: unknown };
    return {
      engine: typeof parsed.engine === "string" ? parsed.engine : undefined,
      sdkSessionId: typeof parsed.sdkSessionId === "string" ? parsed.sdkSessionId : undefined,
      sdkCwd: typeof parsed.sdkCwd === "string" ? parsed.sdkCwd.replace(/^~(?=[\\/])/, getHomeDirectory()) : undefined,
    };
  } catch {
    return {};
  }
}

async function findStateDatabase(codexDir: string): Promise<string | null> {
  const entries = await fs.readdir(codexDir).catch(() => [] as string[]);
  const stateFiles = entries
    .filter((e) => /^state_\d+\.sqlite$/.test(e))
    .sort((a, b) => {
      const na = Number(a.match(/state_(\d+)/)?.[1] ?? 0);
      const nb = Number(b.match(/state_(\d+)/)?.[1] ?? 0);
      return nb - na;
    });
  return stateFiles.length > 0 ? path.join(codexDir, stateFiles[0]) : null;
}

async function walkFiles(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

async function statFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((v) => path.resolve(v)))];
}
