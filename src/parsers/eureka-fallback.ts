import fs from "node:fs/promises";
import path from "node:path";

import { getEurekaClaudeDirectories } from "../core/config.js";
import { encodeClaudeProjectPath } from "../core/source-resolver.js";
import { streamJsonl } from "./util/jsonl-stream.js";
import type { TokenBreakdown, TokenProvenance, UsageEvent } from "../core/types.js";
import type { EurekaIndexEntry } from "./eureka-index.js";

interface SdkTokenResult {
  tokens: TokenBreakdown;
  models: string[];
  modelUsage: Record<string, TokenBreakdown>;
  usageEvents?: UsageEvent[];
  provenance: TokenProvenance;
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface CcUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface CopilotSdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

type CopilotModelMetrics = Record<string, { usage?: CopilotSdkUsage }>;
type CcEnvelope = { type?: string; timestamp?: string; model?: string; usage?: CcUsage; message?: { id?: string; model?: string; usage?: CcUsage } };

export async function readEurekaFallbackTokens(entry: EurekaIndexEntry): Promise<SdkTokenResult | null> {
  if (!entry.sdkSessionId) return null;
  if (entry.underlyingSource === "claude-code") {
    return readCcSessionTokens(entry.sdkSessionId, entry.sdkCwd);
  }
  return readEmbeddedSdkSessionTokens(entry.sessionPath, entry.sdkSessionId, entry.headerModel);
}

export function eurekaEngineLabel(source: EurekaIndexEntry["underlyingSource"]): string {
  if (source === "codex") return "Eureka + Codex";
  if (source === "copilot-cli") return "Eureka + Copilot";
  return "Eureka + CC";
}

export function hasAnyBreakdown(tokens: TokenBreakdown): boolean {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheCreation > 0 || tokens.cacheRead > 0;
}

export function emptyBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

export function addBreakdown(target: TokenBreakdown, delta: TokenBreakdown): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheCreation += delta.cacheCreation;
  target.cacheRead += delta.cacheRead;
}

async function readCcSessionTokens(sdkSessionId: string, sdkCwd?: string): Promise<SdkTokenResult | null> {
  if (!sdkCwd) return null;
  const encodedCwd = encodeClaudeProjectPath(sdkCwd);
  if (!encodedCwd) return null;
  const tokens = emptyBreakdown();
  const models = new Set<string>();
  const modelUsage: Record<string, TokenBreakdown> = {};
  const usageEvents: UsageEvent[] = [];
  let found = false;

  for (const claudeDir of getEurekaClaudeDirectories()) {
    const ccDir = path.join(claudeDir, "projects", encodedCwd);
    const mainFile = path.join(ccDir, `${sdkSessionId}.jsonl`);
    if (await accumulateCcJsonl(mainFile, tokens, models, modelUsage, usageEvents, sdkSessionId)) {
      found = true;
    }
    const subDir = path.join(ccDir, sdkSessionId, "subagents");
    try {
      const subs = await fs.readdir(subDir);
      for (const sub of subs) {
        if (!sub.endsWith(".jsonl")) continue;
        if (await accumulateCcJsonl(path.join(subDir, sub), tokens, models, modelUsage, usageEvents, `${sdkSessionId}:${sub}`)) {
          found = true;
        }
      }
    } catch {}
  }

  return found ? { tokens, models: [...models], modelUsage, usageEvents, provenance: "sdk-cc-jsonl" } : null;
}

async function readEmbeddedSdkSessionTokens(sessionPath: string, sdkSessionId: string, fallbackModel?: string): Promise<SdkTokenResult | null> {
  const copilotEventsPath = path.join(sessionPath, ".copilot-sdk", "session-state", sdkSessionId, "events.jsonl");
  const copilotResult = await readCopilotSdkSessionTokens(copilotEventsPath, fallbackModel);
  if (copilotResult) {
    return copilotResult;
  }

  const codexHome = path.join(sessionPath, ".codex-home", "sessions");
  try {
    const files = await walkDir(codexHome, ".jsonl");
    for (const file of files) {
      if (!path.basename(file).includes(sdkSessionId)) continue;
      const result = await extractCodexTurnModelUsage(file, fallbackModel);
      if (result) {
        return result;
      }
    }
  } catch {}
  return null;
}

async function extractCodexTurnModelUsage(filePath: string, fallbackModel?: string): Promise<SdkTokenResult | null> {
  const tokens = emptyBreakdown();
  const models = new Set<string>();
  const modelUsage: Record<string, TokenBreakdown> = {};
  const usageEvents: UsageEvent[] = [];
  let currentModel = fallbackModel;
  let previousUsage: CodexTokenUsage | null = null;
  let foundUsage = false;
  const fallbackTimestamp = new Date((await fs.stat(filePath).catch(() => ({ mtimeMs: 0 }))).mtimeMs).toISOString();

  const stats = await streamJsonl(filePath, (obj, lineNo) => {
    if (!obj || typeof obj !== "object") return;
    const parsed = obj as { type?: string; timestamp?: string; payload?: { model?: unknown; info?: { total_token_usage?: CodexTokenUsage } } };
    if (parsed.type === "turn_context") {
      const turnModel = typeof parsed.payload?.model === "string" ? parsed.payload.model : undefined;
      if (turnModel) {
        currentModel = turnModel;
        models.add(turnModel);
      }
      return;
    }
    const totalUsage = parsed.payload?.info?.total_token_usage;
    if (!totalUsage || typeof totalUsage.input_tokens !== "number") return;
    const delta = previousUsage ? diffCodexUsage(totalUsage, previousUsage) : totalUsage;
    previousUsage = totalUsage;
    if (!delta) return;

    foundUsage = true;
    const currentTokens = codexUsageToBreakdown(delta);
    addBreakdown(tokens, currentTokens);
    const attributionModel = currentModel ?? fallbackModel;
    if (!attributionModel) return;
    models.add(attributionModel);
    const usage = modelUsage[attributionModel] ?? (modelUsage[attributionModel] = emptyBreakdown());
    addBreakdown(usage, currentTokens);
    usageEvents.push({
      at: parsed.timestamp && !Number.isNaN(Date.parse(parsed.timestamp)) ? new Date(Date.parse(parsed.timestamp)).toISOString() : fallbackTimestamp,
      model: attributionModel,
      tokens: currentTokens,
      requestId: `${path.basename(filePath)}:${lineNo}`,
    });
  });

  if (!stats || !foundUsage) return null;
  if (models.size === 0 && fallbackModel) {
    models.add(fallbackModel);
    modelUsage[fallbackModel] = { ...tokens };
  }
  return { tokens, models: [...models], modelUsage, usageEvents, provenance: "sdk-codex-rollout" };
}

async function readCopilotSdkSessionTokens(eventsPath: string, fallbackModel?: string): Promise<SdkTokenResult | null> {
  const aggregate = emptyBreakdown();
  const modelUsage: Record<string, TokenBreakdown> = {};
  const usageEvents: UsageEvent[] = [];
  let lastShutdown: SdkTokenResult | null = null;
  const turnEndUsage = emptyBreakdown();
  const messageUsage = emptyBreakdown();
  const otherUsage = emptyBreakdown();
  let sawTurnEndUsage = false;
  let sawEventUsage = false;

  const stats = await streamJsonl(eventsPath, (obj) => {
    if (!obj || typeof obj !== "object") return;
    const event = obj as { type?: string; timestamp?: string; data?: { usage?: CopilotSdkUsage; modelMetrics?: CopilotModelMetrics; model?: string } };
    if (event.type === "session.shutdown") {
      const shutdownResult = shutdownMetricsToResult(event.data?.modelMetrics);
      if (shutdownResult) lastShutdown = shutdownResult;
      return;
    }

    const usage = copilotUsageToBreakdown(event.data?.usage);
    if (!hasAnyBreakdown(usage)) return;
    sawEventUsage = true;
    if (event.type === "assistant.turn_end") {
      sawTurnEndUsage = true;
      addBreakdown(turnEndUsage, usage);
    } else if (event.type === "assistant.message") {
      addBreakdown(messageUsage, usage);
    } else {
      addBreakdown(otherUsage, usage);
    }
    if (event.timestamp && !Number.isNaN(Date.parse(event.timestamp))) {
      const model = stringOrUndefined(event.data?.model) ?? fallbackModel ?? "unknown";
      usageEvents.push({ at: new Date(Date.parse(event.timestamp)).toISOString(), model, tokens: usage, requestId: `${event.type}:${usageEvents.length + 1}` });
    }
  });

  if (!stats) return null;
  if (lastShutdown) return lastShutdown;
  if (!sawEventUsage) return null;

  addBreakdown(aggregate, otherUsage);
  addBreakdown(aggregate, sawTurnEndUsage ? turnEndUsage : messageUsage);
  const models = fallbackModel ? [fallbackModel] : [];
  if (fallbackModel) modelUsage[fallbackModel] = { ...aggregate };
  return { tokens: aggregate, modelUsage, models, usageEvents, provenance: "sdk-events" };
}

function diffCodexUsage(current: CodexTokenUsage, previous: CodexTokenUsage): CodexTokenUsage | null {
  const input_tokens = numberOrZero(current.input_tokens) - numberOrZero(previous.input_tokens);
  const cached_input_tokens = numberOrZero(current.cached_input_tokens) - numberOrZero(previous.cached_input_tokens);
  const output_tokens = numberOrZero(current.output_tokens) - numberOrZero(previous.output_tokens);
  if (input_tokens < 0 || cached_input_tokens < 0 || output_tokens < 0) return null;
  if (input_tokens === 0 && cached_input_tokens === 0 && output_tokens === 0) return null;
  return { input_tokens, cached_input_tokens, output_tokens };
}

function codexUsageToBreakdown(usage: CodexTokenUsage): TokenBreakdown {
  const totalInput = numberOrZero(usage.input_tokens);
  const cacheRead = numberOrZero(usage.cached_input_tokens);
  return { input: Math.max(0, totalInput - cacheRead), output: numberOrZero(usage.output_tokens), cacheCreation: 0, cacheRead };
}

async function walkDir(dir: string, ext: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...await walkDir(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) results.push(full);
    }
  } catch {}
  return results;
}

async function accumulateCcJsonl(
  filePath: string,
  tokens: TokenBreakdown,
  models: Set<string>,
  modelUsage: Record<string, TokenBreakdown>,
  usageEvents: UsageEvent[],
  requestPrefix: string,
): Promise<boolean> {
  let found = false;
  const fallbackTimestamp = new Date((await fs.stat(filePath).catch(() => ({ mtimeMs: 0 }))).mtimeMs).toISOString();
  const seenUsageKeys = new Set<string>();
  const stats = await streamJsonl(filePath, (obj, lineNo) => {
    if (!obj || typeof obj !== "object") return;
    const envelope = obj as CcEnvelope;
    if (envelope.type !== "assistant") return;
    const model = stringOrUndefined(envelope.message?.model ?? envelope.model);
    if (model && !model.startsWith("<")) models.add(model);
    const usage = ccUsageToBreakdown(envelope.message?.usage ?? envelope.usage);
    if (!hasAnyBreakdown(usage)) return;
    const dedupeKey = envelope.message?.id
      ? `${envelope.message.id}:${model ?? "unknown"}:${usage.input}:${usage.output}:${usage.cacheCreation}:${usage.cacheRead}`
      : undefined;
    if (dedupeKey && seenUsageKeys.has(dedupeKey)) return;
    if (dedupeKey) seenUsageKeys.add(dedupeKey);
    found = true;
    addBreakdown(tokens, usage);
    const eventModel = model ?? "unknown";
    const eventTimestamp = envelope.timestamp && !Number.isNaN(Date.parse(envelope.timestamp))
      ? new Date(Date.parse(envelope.timestamp)).toISOString()
      : fallbackTimestamp;
    usageEvents.push({
      at: eventTimestamp,
      model: eventModel,
      tokens: usage,
      requestId: stringOrUndefined(envelope.message?.id) ?? `${requestPrefix}:${lineNo}`,
    });
    if (!model) return;
    const bucket = modelUsage[model] ?? (modelUsage[model] = emptyBreakdown());
    addBreakdown(bucket, usage);
  });
  return Boolean(stats && found);
}

function shutdownMetricsToResult(metrics: CopilotModelMetrics | undefined): SdkTokenResult | null {
  if (!metrics || typeof metrics !== "object") return null;
  const tokens = emptyBreakdown();
  const modelUsage: Record<string, TokenBreakdown> = {};
  const models = Object.entries(metrics)
    .map(([modelId, metric]) => [modelId, copilotUsageToBreakdown(metric.usage)] as const)
    .filter(([, usage]) => hasAnyBreakdown(usage))
    .sort(([left], [right]) => left.localeCompare(right));
  if (models.length === 0) return null;
  for (const [modelId, usage] of models) {
    addBreakdown(tokens, usage);
    modelUsage[modelId] = { ...usage };
  }
  return { tokens, modelUsage, models: models.map(([modelId]) => modelId), provenance: "sdk-shutdown" };
}

function ccUsageToBreakdown(usage: CcUsage | undefined): TokenBreakdown {
  return {
    input: numberOrZero(usage?.input_tokens),
    output: numberOrZero(usage?.output_tokens),
    cacheCreation: numberOrZero(usage?.cache_creation_input_tokens),
    cacheRead: numberOrZero(usage?.cache_read_input_tokens),
  };
}

function copilotUsageToBreakdown(usage: CopilotSdkUsage | undefined): TokenBreakdown {
  const cacheRead = numberOrZero(usage?.cacheReadTokens);
  return {
    input: Math.max(0, numberOrZero(usage?.inputTokens) - cacheRead),
    output: numberOrZero(usage?.outputTokens),
    cacheCreation: numberOrZero(usage?.cacheWriteTokens),
    cacheRead,
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
