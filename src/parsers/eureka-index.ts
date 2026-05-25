import fs from "node:fs/promises";
import path from "node:path";

import { getEurekaClaudeDirectories, getHomeDirectory } from "../core/config.js";
import { inferUnderlyingSource } from "../core/orchestrator.js";
import { encodeClaudeProjectPath } from "../core/source-resolver.js";
import type { ParserContext, Source, TokenBreakdown, TokenProvenance } from "../core/types.js";

interface LlmTelemetryEntry {
  kind: "llm_telemetry";
  timestamp: string;
  turnId?: string;
  sessionType?: string;
  runtimeProvider?: string;
  provider?: string;
  workspaceRootPath?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

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
}

export interface EurekaIndexEntry {
  compositeKey: string;
  eurekaSessionId: string;
  workspaceId: string;
  underlyingSource: Source;
  sdkSessionId?: string;
  sdkCwd?: string;
  headerModel?: string;
  telemetryTokens?: TokenBreakdown;
  telemetryProvenance?: TokenProvenance;
  workspacePath?: string;
  workingDirectory?: string;
  engine?: string;
  runtimeProvider?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTimestampsMs: number[];
  name?: string;
  sessionType?: string;
  messageCount?: number;
  userTurns?: number;
  sessionPath: string;
}

export interface EurekaIndex {
  byCompositeKey: Map<string, EurekaIndexEntry>;
  bySdkSessionId: Map<string, EurekaIndexEntry[]>;
  lookup(sdkSessionId: string, sdkCwd?: string): EurekaIndexEntry | undefined;
}

export async function buildEurekaIndex(context: ParserContext): Promise<EurekaIndex> {
  const enabledEureka = (context.sources ?? [])
    .filter((source) => source.enabled && source.type === "eureka")
    .map((source) => source.path);
  const workspacesDirs = enabledEureka.length > 0
    ? enabledEureka
    : [
        path.join(getHomeDirectory(), ".craft-agent", "workspaces"),
        path.join(getHomeDirectory(), ".eureka", "workspaces"),
      ];
  const discovered: EurekaIndexEntry[] = [];

  for (const workspacesDir of workspacesDirs) {
    const stat = await safeStat(workspacesDir);
    if (!stat?.isDirectory()) continue;
    const workspaces = (await fs.readdir(workspacesDir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const sessionsDir = path.join(workspacesDir, workspace.name, "sessions");
      const sessionsDirStat = await safeStat(sessionsDir);
      if (!sessionsDirStat?.isDirectory()) continue;
      const sessionDirs = (await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;
        const entry = await readEurekaIndexEntry(path.join(sessionsDir, sessionDir.name), workspace.name);
        if (!entry) continue;
        discovered.push(entry);
      }
    }
  }

  const deduped = await dedupeEurekaEntries(discovered);
  const byCompositeKey = new Map<string, EurekaIndexEntry>();
  const bySdkSessionId = new Map<string, EurekaIndexEntry[]>();
  for (const entry of deduped) {
    byCompositeKey.set(entry.compositeKey, entry);
    if (!entry.sdkSessionId) continue;
    const matches = bySdkSessionId.get(entry.sdkSessionId) ?? [];
    matches.push(entry);
    bySdkSessionId.set(entry.sdkSessionId, matches);
  }

  return {
    byCompositeKey,
    bySdkSessionId,
    lookup(sdkSessionId: string, sdkCwd?: string) {
      const composite = makeEurekaCompositeKey(sdkSessionId, sdkCwd, sdkSessionId);
      const direct = byCompositeKey.get(composite);
      if (direct) return direct;
      const matches = bySdkSessionId.get(sdkSessionId) ?? [];
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        console.warn(`[eureka] ambiguous sdkSessionId lookup: ${sdkSessionId}`);
      }
      return undefined;
    },
  };
}

async function dedupeEurekaEntries(entries: EurekaIndexEntry[]): Promise<EurekaIndexEntry[]> {
  const grouped = new Map<string, EurekaIndexEntry[]>();
  for (const entry of entries) {
    const key = `${entry.underlyingSource}:${entry.eurekaSessionId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }

  const deduped: EurekaIndexEntry[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }

    let best = group[0];
    let bestScore = await scoreEurekaEntry(group[0]);
    for (let index = 1; index < group.length; index += 1) {
      const candidate = group[index];
      const candidateScore = await scoreEurekaEntry(candidate);
      if (candidateScore > bestScore) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
    deduped.push(best);
  }

  return deduped;
}

async function scoreEurekaEntry(entry: EurekaIndexEntry): Promise<number> {
  let score = 0;
  if (await hasSdkArtifacts(entry)) score += 1_000_000;
  if (entry.telemetryTokens && hasAnyTokens(entry.telemetryTokens)) score += 100_000;
  score += Date.parse(entry.lastTimestamp ?? entry.firstTimestamp ?? new Date(0).toISOString()) || 0;
  return score;
}

async function hasSdkArtifacts(entry: EurekaIndexEntry): Promise<boolean> {
  if (!entry.sdkSessionId) return false;
  if (entry.underlyingSource === "claude-code") {
    const encoded = entry.sdkCwd ? encodeClaudeProjectPath(entry.sdkCwd) : null;
    if (!encoded) return false;
    for (const claudeDir of getEurekaClaudeDirectories()) {
      const mainFile = path.join(claudeDir, "projects", encoded, `${entry.sdkSessionId}.jsonl`);
      if (await safeStat(mainFile)) return true;
      const subDir = path.join(claudeDir, "projects", encoded, entry.sdkSessionId, "subagents");
      const subStat = await safeStat(subDir);
      if (subStat?.isDirectory()) return true;
    }
    return false;
  }
  if (entry.underlyingSource === "codex") {
    const codexDir = path.join(entry.sessionPath, ".codex-home", "sessions");
    return hasNestedJsonlMatching(codexDir, entry.sdkSessionId);
  }
  const eventsPath = path.join(entry.sessionPath, ".copilot-sdk", "session-state", entry.sdkSessionId, "events.jsonl");
  return Boolean(await safeStat(eventsPath));
}

async function hasNestedJsonlMatching(rootDir: string, sdkSessionId: string): Promise<boolean> {
  const stat = await safeStat(rootDir);
  if (!stat?.isDirectory()) return false;
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (await hasNestedJsonlMatching(candidate, sdkSessionId)) return true;
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sdkSessionId)) {
      return true;
    }
  }
  return false;
}

export function makeEurekaCompositeKey(sdkSessionId: string | undefined, sdkCwd: string | undefined, eurekaSessionId: string): string {
  return sdkSessionId ? `${sdkSessionId}::${sdkCwd ?? ""}` : `eureka::${eurekaSessionId}`;
}

async function readEurekaIndexEntry(sessionPath: string, workspaceId: string): Promise<EurekaIndexEntry | null> {
  const sessionJsonlPath = path.join(sessionPath, "session.jsonl");
  const telemetryPath = path.join(sessionPath, "llm-telemetry.jsonl");
  const header = await readSessionHeader(sessionJsonlPath);
  const telemetry = await readTelemetry(telemetryPath);
  const eurekaSessionId = header?.id ?? path.basename(sessionPath);
  const runtimeProvider = header?.runtimeProvider ?? telemetry.runtimeProvider;
  const engine = header?.engine;
  const sdkSessionId = stringOrUndefined(header?.sdkSessionId);
  const sdkCwd = expandHomePath(header?.sdkCwd);

  return {
    compositeKey: makeEurekaCompositeKey(sdkSessionId, sdkCwd, eurekaSessionId),
    eurekaSessionId,
    workspaceId,
    underlyingSource: inferUnderlyingSource(runtimeProvider, engine),
    sdkSessionId,
    sdkCwd,
    headerModel: stringOrUndefined(header?.model),
    telemetryTokens: telemetry.hasTokens ? telemetry.tokens : undefined,
    telemetryProvenance: telemetry.hasTokens ? "telemetry" : "none",
    workspacePath: expandHomePath(header?.workspaceRootPath ?? telemetry.workspacePath),
    workingDirectory: expandHomePath(header?.workingDirectory),
    engine,
    runtimeProvider,
    firstTimestamp: header?.createdAt ? new Date(header.createdAt).toISOString() : telemetry.firstTimestamp,
    lastTimestamp: header?.lastUsedAt ? new Date(header.lastUsedAt).toISOString() : telemetry.lastTimestamp,
    eventTimestampsMs: telemetry.eventTimestampsMs,
    name: stringOrUndefined(header?.name),
    sessionType: stringOrUndefined(header?.type ?? telemetry.sessionType),
    messageCount: numberOrUndefined(header?.messageCount),
    userTurns: numberOrUndefined(header?.userMessageCount) ?? telemetry.turnCount,
    sessionPath,
  };
}

async function readSessionHeader(sessionJsonlPath: string): Promise<SessionHeaderEntry | null> {
  const raw = await fs.readFile(sessionJsonlPath, "utf8").catch(() => "");
  const firstLine = raw.split(/\r?\n/)[0];
  return firstLine ? parseJsonLine<SessionHeaderEntry>(firstLine) : null;
}

async function readTelemetry(telemetryPath: string): Promise<{
  tokens: TokenBreakdown;
  hasTokens: boolean;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTimestampsMs: number[];
  turnCount: number;
  workspacePath?: string;
  runtimeProvider?: string;
  sessionType?: string;
}> {
  const tokens: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const eventTimestampsMs: number[] = [];
  const turns = new Set<string>();
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let workspacePath: string | undefined;
  let runtimeProvider: string | undefined;
  let sessionType: string | undefined;

  const raw = await fs.readFile(telemetryPath, "utf8").catch(() => "");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseJsonLine<LlmTelemetryEntry>(line);
    if (!entry || entry.kind !== "llm_telemetry") continue;
    if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
    if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
    const timestampMs = Date.parse(entry.timestamp);
    if (Number.isFinite(timestampMs)) eventTimestampsMs.push(timestampMs);
    if (entry.turnId) turns.add(entry.turnId);
    if (!workspacePath && entry.workspaceRootPath) workspacePath = entry.workspaceRootPath;
    if (!runtimeProvider && entry.runtimeProvider) runtimeProvider = entry.runtimeProvider;
    if (!sessionType && entry.sessionType) sessionType = entry.sessionType;
    if (entry.provider && entry.provider !== "anthropic") {
      const cacheRead = numberOrZero(entry.cacheReadTokens);
      tokens.input += Math.max(0, numberOrZero(entry.inputTokens) - cacheRead);
      tokens.output += numberOrZero(entry.outputTokens);
      tokens.cacheRead += cacheRead;
      tokens.cacheCreation += numberOrZero(entry.cacheCreationTokens);
    }
  }

  return {
    tokens,
    hasTokens: hasAnyTokens(tokens),
    firstTimestamp,
    lastTimestamp,
    eventTimestampsMs,
    turnCount: turns.size,
    workspacePath,
    runtimeProvider,
    sessionType,
  };
}

function hasAnyTokens(tokens: TokenBreakdown): boolean {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheCreation > 0 || tokens.cacheRead > 0;
}

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function expandHomePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^~/, getHomeDirectory());
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
