import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { parseAllPure } from "./parse-pure.js";
import { sanitizeSensitiveText } from "./sanitize.js";

interface Manifest {
  epoch: number;
  fileMtimes?: Record<string, number>;
}

export async function regenerateGolden(corpusRoot: string): Promise<void> {
  const root = path.resolve(corpusRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as Manifest;
  await restoreMtimes(root, manifest.fileMtimes ?? {});

  const prevHome = process.env.TOKMON_HOME;
  process.env.TOKMON_HOME = path.join(root, "home");
  try {
    const sessions = await parseAllPure({ forceAllSources: true });
    const normalized = normalizeForGolden(sessions, manifest.epoch);
    const goldenDir = path.join(root, "golden");
    await fs.mkdir(goldenDir, { recursive: true });
    await fs.writeFile(path.join(goldenDir, "sessions.json"), JSON.stringify(normalized, null, 2) + "\n", "utf8");
  } finally {
    if (prevHome === undefined) delete process.env.TOKMON_HOME;
    else process.env.TOKMON_HOME = prevHome;
  }
}

export function registerCorpusRegenerateGolden(command: Command): void {
  command
    .command("regenerate-golden")
    .requiredOption("--corpus <dir>")
    .action(async (opts: { corpus: string }) => {
      await regenerateGolden(opts.corpus);
      console.log(`Golden regenerated for ${opts.corpus}`);
    });
}

export function normalizeForGolden<T>(value: T, epochMs: number): T {
  const normalized = deepNormalize(value, epochMs) as T;
  if (Array.isArray(normalized)) {
    normalized.sort((a, b) => {
      const aa = a as { source?: string; id?: string };
      const bb = b as { source?: string; id?: string };
      const bySource = String(aa.source ?? "").localeCompare(String(bb.source ?? ""));
      if (bySource !== 0) return bySource;
      return String(aa.id ?? "").localeCompare(String(bb.id ?? ""));
    });
  }
  return normalized;
}

async function restoreMtimes(root: string, fileMtimes: Record<string, number>): Promise<void> {
  for (const [rel, mtimeMs] of Object.entries(fileMtimes)) {
    const full = path.join(root, rel);
    const seconds = mtimeMs / 1000;
    await fs.utimes(full, seconds, seconds).catch(() => undefined);
  }
}

function deepNormalize(value: unknown, epochMs: number): unknown {
  if (typeof value === "string") {
    return sanitizeSensitiveText(value);
  }
  if (Array.isArray(value)) return value.map((v) => deepNormalize(v, epochMs));
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "machineId") {
      out[key] = "machine";
      continue;
    }
    if ((/timestamp|At$/i.test(key)) && typeof val === "string") {
      const ms = Date.parse(val);
      out[key] = Number.isFinite(ms) ? Math.round((ms - epochMs) / 1000) : val;
      continue;
    }
    out[key] = deepNormalize(val, epochMs);
  }
  return out;
}
