import fs from "node:fs/promises";
import path from "node:path";

import { getPricingDirectory, pathExists } from "./config.js";
import type {
  CostBreakdown,
  LiteLLMPricing,
  LiteLLMPricingEntry,
  ModelPricing,
  PricingSnapshot,
  Source,
  TokenBreakdown,
} from "./types.js";

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const SOURCE_DEFAULT_PRICING: Record<Source, ModelPricing> = {
  "claude-code": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  codex: { input: 2, output: 8, cacheWrite: 2.5, cacheRead: 0.5 },
  "copilot-cli": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  eureka: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  mars: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

export function normalizeModelName(model: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  add(model);
  if (model.includes("/")) {
    add(model.split("/").pop());
  }

  const versionMatch = model.match(/^(.+)-\d{8}$/);
  add(versionMatch?.[1]);

  const bedrockMatch = model.match(/^anthropic\.(.+)-v\d+:\d+$/);
  add(bedrockMatch?.[1]);

  return candidates;
}

export function extractPricing(entry: LiteLLMPricingEntry): ModelPricing {
  return {
    input: (entry.input_cost_per_token ?? 0) * 1_000_000,
    output: (entry.output_cost_per_token ?? 0) * 1_000_000,
    cacheWrite: (entry.cache_creation_input_token_cost ?? entry.input_cost_per_token ?? 0) * 1_000_000,
    cacheRead: (entry.cache_read_input_token_cost ?? 0) * 1_000_000,
  };
}

export function lookupPricing(pricingData: LiteLLMPricing, model: string, source: Source): ModelPricing {
  const candidates = normalizeModelName(model);
  for (const candidate of candidates) {
    const direct = pricingData[candidate];
    if (direct) {
      return extractPricing(direct);
    }
  }

  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(pricingData)) {
      if (key.startsWith(candidate) || candidate.startsWith(key)) {
        return extractPricing(value);
      }
    }
  }

  return SOURCE_DEFAULT_PRICING[source];
}

export function calculateCost(usage: TokenBreakdown, pricing: ModelPricing): CostBreakdown {
  const million = 1_000_000;
  const input = (usage.input / million) * pricing.input;
  const output = (usage.output / million) * pricing.output;
  const cacheCreation = (usage.cacheCreation / million) * pricing.cacheWrite;
  const cacheRead = (usage.cacheRead / million) * pricing.cacheRead;

  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total: input + output + cacheCreation + cacheRead,
  };
}

export async function maybeRefreshPricing(updateIntervalHours: number, autoUpdate: boolean): Promise<void> {
  if (!autoUpdate) {
    return;
  }

  const pricingDir = getPricingDirectory();
  const latestPath = path.join(pricingDir, "latest.json");
  if (await pathExists(latestPath)) {
    const stat = await fs.stat(latestPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < updateIntervalHours * 60 * 60 * 1000) {
      return;
    }
  }

  await refreshPricingSnapshots();
}

export async function refreshPricingSnapshots(): Promise<PricingSnapshot> {
  await fs.mkdir(getPricingDirectory(), { recursive: true });
  const response = await fetch(LITELLM_PRICING_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch LiteLLM pricing: ${response.status} ${response.statusText}`);
  }

  const pricing = (await response.json()) as LiteLLMPricing;
  const snapshot: PricingSnapshot = {
    fetchedAt: new Date().toISOString(),
    source: LITELLM_PRICING_URL,
    pricing,
  };

  const latestPath = path.join(getPricingDirectory(), "latest.json");
  const latestExisting = await readSnapshotFile(latestPath);
  const changed = JSON.stringify(latestExisting?.pricing ?? {}) !== JSON.stringify(pricing);
  const body = JSON.stringify(snapshot, null, 2) + "\n";

  await fs.writeFile(latestPath, body, "utf8");
  if (changed || !latestExisting) {
    const safeName = snapshot.fetchedAt.replace(/:/g, "-");
    await fs.writeFile(path.join(getPricingDirectory(), `${safeName}.json`), body, "utf8");
  }

  return snapshot;
}

export async function loadPricingForDate(sessionDate: Date): Promise<PricingSnapshot | null> {
  const pricingDir = getPricingDirectory();
  if (!(await pathExists(pricingDir))) {
    return null;
  }

  const snapshots = (await fs.readdir(pricingDir))
    .filter((file) => file.endsWith(".json") && file !== "latest.json")
    .sort();

  if (snapshots.length === 0) {
    return readSnapshotFile(path.join(pricingDir, "latest.json"));
  }

  const selected = selectPricingSnapshot(sessionDate, snapshots);
  return readSnapshotFile(path.join(pricingDir, selected));
}

export function selectPricingSnapshot(sessionDate: Date, snapshots: string[]): string {
  const sorted = [...snapshots].sort().reverse();
  for (const snapshot of sorted) {
    const stem = snapshot.replace(/\.json$/, "");
    // Filenames on Windows use hyphens instead of colons in the time part.
    // Convert back to ISO (e.g. "2026-04-17T07-29-45.640Z" -> "2026-04-17T07:29:45.640Z").
    const isoish = stem.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
    const snapshotDate = new Date(isoish);
    if (snapshotDate <= sessionDate) {
      return snapshot;
    }
  }
  return sorted[sorted.length - 1];
}

export async function calculateSessionCost(
  sessionDate: Date,
  usage: TokenBreakdown,
  model: string,
  source: Source,
): Promise<CostBreakdown> {
  const snapshot = await loadPricingForDate(sessionDate);
  const pricing = lookupPricing(snapshot?.pricing ?? {}, model, source);
  return calculateCost(usage, pricing);
}

async function readSnapshotFile(filePath: string): Promise<PricingSnapshot | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }
  return JSON.parse(await fs.readFile(filePath, "utf8")) as PricingSnapshot;
}
