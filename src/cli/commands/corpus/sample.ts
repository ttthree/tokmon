import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import Database from "better-sqlite3";

import { detectAvailableSources, getPricingDirectory } from "../../../core/config.js";
import { getPackageVersion } from "../../../core/version.js";
import { discoverSessions, type DiscoveredSession, type SourceCategory } from "./discover.js";
import { resetSanitizeState, sanitizeCopilotLog, sanitizeJsonlLine, sanitizePath, sanitizeSqlite } from "./sanitize.js";

export interface CorpusSampleOptions {
  out: string;
  maxSessionsPerSource?: number;
  maxBytesPerFile?: number;
  seed?: number;
}

interface CorpusManifest {
  id: string;
  schemaVersion: number;
  createdAt: string;
  epoch: number;
  seed: number;
  sourceCounts: Record<string, number>;
  fileMtimes: Record<string, number>;
  totalBytes: number;
  tokmonVersion: string;
  sha256: string;
}

export async function corpusSampleCommand(options: CorpusSampleOptions): Promise<void> {
  const outDir = path.resolve(options.out);
  const homeDir = path.join(outDir, "home");
  const pricingDir = path.join(homeDir, ".tokmon", "pricing");
  const seed = options.seed ?? 42;
  const maxPerSource = options.maxSessionsPerSource ?? 25;
  const maxBytes = options.maxBytesPerFile ?? 256 * 1024;

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(homeDir, { recursive: true });

  resetSanitizeState();
  const detected = (await detectAvailableSources()).map((s) => ({ ...s, enabled: true }));
  const realHome = process.env.TOKMON_HOME ?? os.homedir();
  const discovered = await discoverSessions(detected);
  const marsEntries = detected.filter((s) => s.type === "mars");
  const marsTasks = await discoverMarsTasks(marsEntries);
  const selectedMarsTasks = marsTasks
    .sort((a, b) => stableRank(seed, a.taskId).localeCompare(stableRank(seed, b.taskId)))
    .slice(0, Math.min(3, marsTasks.length));
  const selected = selectDiscovered(discovered, seed, maxPerSource);
  const marsSessionIds = new Set(selectedMarsTasks.flatMap((t) => t.agentSessionIds));
  for (const session of discovered) {
    if (marsSessionIds.has(session.sessionId)) selected.push(session);
  }

  const copied = new Set<string>();
  const selectedTaskIds = new Set<string>();
  const fileMtimes: Record<string, number> = {};
  let totalBytes = 0;

  for (const session of selected) {
    const files = [session.primaryFile, ...session.auxFiles];
    for (const file of files) {
      if (copied.has(file)) continue;
      copied.add(file);
      const result = await materializeFile(file, outDir, realHome, maxBytes, selectedTaskIds);
      if (!result) continue;
      fileMtimes[result.relPath] = result.mtimeMs;
      totalBytes += result.size;
    }
  }

  for (const marsTask of selectedMarsTasks) {
    selectedTaskIds.add(marsTask.taskId);
    const dbPath = path.join(marsTask.appDir, "marsiwe.db");
    if (!copied.has(dbPath)) {
      copied.add(dbPath);
      const result = await materializeFile(dbPath, outDir, realHome, maxBytes, selectedTaskIds);
      if (result) {
        fileMtimes[result.relPath] = result.mtimeMs;
        totalBytes += result.size;
      }
    }
    for (const root of ["claude", "codex", "copilot"]) {
      const configRoot = path.join(marsTask.appDir, "agent-configs", root);
      const files = await walk(configRoot);
      for (const file of files) {
        if (!copied.has(file)) {
          copied.add(file);
          const result = await materializeFile(file, outDir, realHome, maxBytes, selectedTaskIds);
          if (result) {
            fileMtimes[result.relPath] = result.mtimeMs;
            totalBytes += result.size;
          }
        }
      }
    }
  }

  const sourceCounts = countBySource(selected);
  if (selectedMarsTasks.length > 0) sourceCounts["mars-trees"] = selectedMarsTasks.length;

  const synthetic = await ensureSyntheticCopilotCorpusFile(outDir);
  if (synthetic) {
    fileMtimes[synthetic.relPath] = synthetic.mtimeMs;
    totalBytes += synthetic.size;
    sourceCounts["copilot-cli"] = (sourceCounts["copilot-cli"] ?? 0) + 1;
  }

  await copyPricingSnapshot(pricingDir);
  const manifest: CorpusManifest = {
    id: path.basename(outDir),
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    epoch: Date.now(),
    seed,
    sourceCounts,
    fileMtimes,
    totalBytes,
    tokmonVersion: getPackageVersion(),
    sha256: await computeCorpusHash(outDir),
  };
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function registerCorpusSample(command: Command): void {
  command
    .command("sample")
    .requiredOption("--out <dir>")
    .option("--max-sessions-per-source <n>", "max sessions per source", (v) => Number(v), 25)
    .option("--max-bytes-per-file <n>", "max bytes per file", (v) => Number(v), 256 * 1024)
    .option("--seed <n>", "selection seed", (v) => Number(v), 42)
    .action(async (opts: { out: string; maxSessionsPerSource: number; maxBytesPerFile: number; seed: number }) => {
      await corpusSampleCommand({
        out: opts.out,
        maxSessionsPerSource: opts.maxSessionsPerSource,
        maxBytesPerFile: opts.maxBytesPerFile,
        seed: opts.seed,
      });
      console.log(`Corpus sampled at ${opts.out}`);
    });
}

export function selectDiscovered(all: DiscoveredSession[], seed: number, maxPerSource: number): DiscoveredSession[] {
  const groups = new Map<SourceCategory, DiscoveredSession[]>();
  for (const item of all) {
    const group = groups.get(item.sourceCategory) ?? [];
    group.push(item);
    groups.set(item.sourceCategory, group);
  }

  const selected: DiscoveredSession[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => stableRank(seed, a.sessionId).localeCompare(stableRank(seed, b.sessionId)));
    selected.push(...group.slice(0, maxPerSource));
  }
  return selected;
}

async function materializeFile(srcPath: string, outRoot: string, realHome: string, maxBytes: number, selectedTaskIds: Set<string>): Promise<{ relPath: string; mtimeMs: number; size: number } | null> {
  const stat = await fs.stat(srcPath).catch(() => null);
  if (!stat?.isFile()) return null;

  const relFromHome = path.relative(realHome, srcPath);
  const relPath = path.join("home", sanitizePath(relFromHome));
  const dstPath = path.join(outRoot, relPath);
  await fs.mkdir(path.dirname(dstPath), { recursive: true });

  if (srcPath.endsWith(".sqlite")) {
    const base = path.basename(srcPath);
    const kind = base === "marsiwe.db" ? "mars" : base === "session-store.db" ? "copilot" : "codex";
    await sanitizeSqlite(srcPath, dstPath, kind, { selectedIds: kind === "mars" ? selectedTaskIds : undefined });
    const outStat = await fs.stat(dstPath);
    return { relPath, mtimeMs: stat.mtimeMs, size: outStat.size };
  }

  if (srcPath.endsWith(".log")) {
    const raw = await fs.readFile(srcPath, "utf8");
    const filtered = sanitizeCopilotLog(raw);
    const out = truncateTextLines(filtered, maxBytes);
    await fs.writeFile(dstPath, out, "utf8");
    const outStat = await fs.stat(dstPath);
    return { relPath, mtimeMs: stat.mtimeMs, size: outStat.size };
  }

  const raw = await fs.readFile(srcPath, "utf8");
  const lines = truncateJsonl(raw, maxBytes, srcPath.includes(".codex"));
  const kind = determineJsonlKind(srcPath);
  const outLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineKind = kind === "eureka-session" ? (i === 0 ? "eureka-header" : "eureka-body") : kind;
    const sanitized = sanitizeJsonlLine(line, lineKind as "cc" | "eureka-header" | "eureka-body" | "codex" | "telemetry");
    if (sanitized === null) continue;
    outLines.push(sanitized);
  }
  await fs.writeFile(dstPath, outLines.join("\n") + "\n", "utf8");
  const outStat = await fs.stat(dstPath);
  return { relPath, mtimeMs: stat.mtimeMs, size: outStat.size };
}

async function copyPricingSnapshot(pricingDir: string): Promise<void> {
  await fs.mkdir(pricingDir, { recursive: true });
  const latest = path.join(getPricingDirectory(), "latest.json");
  const raw = await fs.readFile(latest, "utf8").catch(() => "");
  if (!raw.trim()) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const compact = {
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : new Date().toISOString(),
      source: "redacted",
      pricing: {},
    };
    await fs.writeFile(path.join(pricingDir, "latest.json"), JSON.stringify(compact, null, 2) + "\n", "utf8");
  } catch {
    await fs.writeFile(path.join(pricingDir, "latest.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), source: "redacted", pricing: {} }, null, 2) + "\n", "utf8");
  }
}

function determineJsonlKind(srcPath: string): "cc" | "eureka-session" | "codex" | "telemetry" {
  const normalized = srcPath.replace(/\\/g, "/");
  if (normalized.endsWith("/llm-telemetry.jsonl")) return "telemetry";
  if (normalized.endsWith("/session.jsonl") && normalized.includes("/workspaces/")) return "eureka-session";
  if (normalized.includes("/.codex/")) return "codex";
  if (normalized.includes("/.codex-home/sessions/")) return "codex";
  return "cc";
}

export function truncateJsonl(raw: string, maxBytes: number, isCodex: boolean): string[] {
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) {
    return raw.split(/\r?\n/).filter((l) => l.length > 0);
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const headBudget = Math.floor(maxBytes * 0.75);
  const tailBudgetStart = Math.floor(maxBytes * 0.25);

  const head: string[] = [];
  let headSize = 0;
  for (const line of lines) {
    const len = Buffer.byteLength(line + "\n", "utf8");
    if (headSize + len > headBudget) break;
    head.push(line);
    headSize += len;
  }

  let tailBudget = tailBudgetStart;
  let tail: string[] = [];
  while (true) {
    tail = [];
    let tailSize = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const len = Buffer.byteLength(lines[i] + "\n", "utf8");
      if (tailSize + len > tailBudget) break;
      tail.unshift(lines[i]);
      tailSize += len;
    }
    if (!isCodex) break;
    if (tail.some((line) => line.includes("total_token_usage"))) break;
    if (tailBudget >= Buffer.byteLength(raw, "utf8")) break;
    tailBudget = Math.min(Buffer.byteLength(raw, "utf8"), tailBudget + 64 * 1024);
  }

  return [...head, '{"_truncated":true}', ...tail];
}

function countBySource(items: DiscoveredSession[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    out[item.sourceCategory] = (out[item.sourceCategory] ?? 0) + 1;
  }
  return out;
}

async function computeCorpusHash(root: string): Promise<string> {
  const files = await walk(root);
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) {
    const data = await fs.readFile(file);
    hash.update(path.relative(root, file));
    hash.update(data);
  }
  return hash.digest("hex");
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

function stableRank(seed: number, id: string): string {
  return crypto.createHash("sha1").update(`${seed}:${id}`).digest("hex");
}

async function ensureSyntheticCopilotCorpusFile(outRoot: string): Promise<{ relPath: string; mtimeMs: number; size: number } | null> {
  const logPath = path.join(outRoot, "home", ".copilot", "logs", "process-corpus-synthetic.log");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const payload = [
    '2026-04-18T00:00:00.000Z [INFO] [Telemetry] cli.telemetry:',
    JSON.stringify({
      kind: "assistant_usage",
      timestamp: "2026-04-18T00:00:00.000Z",
      properties: {
        api_call_id: "corpus-api-1",
        model: "claude-sonnet-4-20250514",
        interaction_id: "corpus-interaction-1",
      },
      metrics: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        duration: 100,
      },
    }),
    "",
  ].join("\n");
  await fs.writeFile(logPath, payload, "utf8");

  const dbPath = path.join(outRoot, "home", ".copilot", "session-store.db");
  await fs.rm(dbPath, { force: true }).catch(() => undefined);
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cwd TEXT);");
    db.prepare("INSERT OR REPLACE INTO sessions (id, cwd) VALUES (?, ?)").run("corpus-interaction-1", "/Users/testuser/work/corpus");
  } finally {
    db.close();
  }

  const stat = await fs.stat(logPath);
  return {
    relPath: path.join("home", ".copilot", "logs", "process-corpus-synthetic.log"),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function truncateTextLines(raw: string, maxBytes: number): string {
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return raw;
  const lines = raw.split(/\r?\n/);
  const headBudget = Math.floor(maxBytes * 0.75);
  const tailBudget = Math.floor(maxBytes * 0.25);

  const head: string[] = [];
  let h = 0;
  for (const line of lines) {
    const len = Buffer.byteLength(line + "\n", "utf8");
    if (h + len > headBudget) break;
    head.push(line);
    h += len;
  }

  const tail: string[] = [];
  let t = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = Buffer.byteLength(lines[i] + "\n", "utf8");
    if (t + len > tailBudget) break;
    tail.unshift(lines[i]);
    t += len;
  }
  return [...head, "[TRUNCATED]", ...tail].join("\n");
}

export interface MarsTaskGroup {
  taskId: string;
  appDir: string;
  agentSessionIds: string[];
}

export async function discoverMarsTasks(entries: Array<{ path: string }>): Promise<MarsTaskGroup[]> {
  const out: MarsTaskGroup[] = [];
  for (const entry of entries) {
    const dbPath = path.join(entry.path, "marsiwe.db");
    const stat = await fs.stat(dbPath).catch(() => null);
    if (!stat?.isFile()) continue;
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare("SELECT lower(hex(task_id)) AS task_id, agent_session_id FROM sessions WHERE task_id IS NOT NULL AND agent_session_id IS NOT NULL").all() as Array<{ task_id: string; agent_session_id: string }>;
        const byTask = new Map<string, string[]>();
        for (const row of rows) {
          const arr = byTask.get(row.task_id) ?? [];
          arr.push(row.agent_session_id);
          byTask.set(row.task_id, arr);
        }
        for (const [taskId, agentSessionIds] of byTask) {
          out.push({ taskId, appDir: entry.path, agentSessionIds });
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return out;
}
