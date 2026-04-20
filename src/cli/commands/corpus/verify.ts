import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";

import { parseAllPure } from "./parse-pure.js";
import type { Source } from "../../../core/types.js";
import { sanitizeSensitiveText } from "./sanitize.js";

export async function verifyCorpus(corpusRoot: string): Promise<void> {
  const root = path.resolve(corpusRoot);
  const files = await collectVerificationFiles(root);
  const username = os.userInfo().username;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const usernameRegex = new RegExp(`\\b${escaped}(?:[_-][A-Za-z0-9.-]+)+\\b|\\b${escaped}\\b`, "i");
  const realUserPathRegex = new RegExp(`/Users/${escaped}(?:[_-][^/\\s\"]+)?(?=/|$)`, "i");
  const checks: Array<{ file: string; reason: string }> = [];

  for (const file of files) {
    if (file.endsWith(".sqlite")) continue;
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    if (!raw) continue;
    if (usernameRegex.test(raw)) checks.push({ file, reason: "contains real username variant" });
    if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(raw)) checks.push({ file, reason: "contains email" });
    if (realUserPathRegex.test(raw)) checks.push({ file, reason: "contains /Users/<real-user> absolute path" });
    if (hasNonTestUserPath(raw)) checks.push({ file, reason: "contains non-test absolute path" });
    if ((file.endsWith(".jsonl") || file.endsWith(".log")) && hasLongScrubString(raw)) checks.push({ file, reason: "contains long scrubbed field" });
    if (file.endsWith(".log") && !hasValidCopilotTimestamps(raw)) checks.push({ file, reason: "copilot retained events missing valid ISO timestamp" });
    if (raw !== sanitizeSensitiveText(raw) && (file.endsWith(".log") || file.endsWith(".json") || file.endsWith(".jsonl"))) {
      checks.push({ file, reason: "contains unsanitized sensitive tokens" });
    }
  }

  if (checks.length > 0) {
    const report = checks.map((c) => `- ${c.file}: ${c.reason}`).join("\n");
    throw new Error(`Corpus verification failed:\n${report}`);
  }

  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as { sourceCounts?: Record<string, number> };
  const prevHome = process.env.TOKMON_HOME;
  process.env.TOKMON_HOME = path.join(root, "home");
  try {
    const parsed = await parseAllPure({ forceAllSources: true });
    const sourceSet = new Set(parsed.map((s) => s.source));
    const represented = new Set<Source>();
    let expectsEureka = false;
    let expectsMars = false;
    for (const key of Object.keys(manifest.sourceCounts ?? {})) {
      if (key.startsWith("claude-code")) represented.add("claude-code");
      else if (key.startsWith("eureka-codex")) {
        represented.add("codex");
        expectsEureka = true;
      } else if (key.startsWith("eureka")) {
        represented.add("claude-code");
        expectsEureka = true;
      } else if (key === "codex" || key === "copilot-cli") represented.add(key);
      else if (key === "mars" || key === "mars-trees") expectsMars = true;
    }
    for (const expected of represented) {
      if (!sourceSet.has(expected)) {
        throw new Error(`Parse-still-works check failed: missing source ${expected}`);
      }
    }
    if (expectsEureka && !parsed.some((session) => session.orchestrator?.kind === "eureka")) {
      throw new Error("Parse-still-works check failed: missing eureka orchestrated sessions");
    }
    if (expectsMars && !parsed.some((session) => session.orchestrator?.kind === "mars")) {
      throw new Error("Parse-still-works check failed: missing mars orchestrated sessions");
    }
  } finally {
    if (prevHome === undefined) delete process.env.TOKMON_HOME;
    else process.env.TOKMON_HOME = prevHome;
  }
}

async function collectVerificationFiles(root: string): Promise<string[]> {
  const all = new Set<string>(await walk(root));
  const goldenDir = path.join(root, "golden");
  const hasGolden = await fs.stat(goldenDir).then((s) => s.isDirectory()).catch(() => false);
  if (hasGolden) {
    for (const file of await walk(goldenDir)) all.add(file);
  }
  return [...all];
}

export function registerCorpusVerify(command: Command): void {
  command
    .command("verify")
    .argument("<corpus>")
    .action(async (corpus: string) => {
      await verifyCorpus(corpus);
      console.log(`Corpus verified: ${corpus}`);
    });
}

function hasLongScrubString(raw: string): boolean {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (containsLongScrubField(obj)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function containsLongScrubField(value: unknown): boolean {
  if (typeof value === "string") return false;
  if (Array.isArray(value)) return value.some((v) => containsLongScrubField(v));
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (["text", "prompt", "response", "content", "summary"].includes(k) && typeof v === "string" && v.length > 100) {
      return true;
    }
    if (containsLongScrubField(v)) return true;
  }
  return false;
}

function hasValidCopilotTimestamps(raw: string): boolean {
  const matches = [...raw.matchAll(/"timestamp"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (matches.length === 0) return true;
  return matches.every((ts) => Number.isFinite(Date.parse(ts)));
}

function hasNonTestUserPath(raw: string): boolean {
  for (const match of raw.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) {
    const user = (match[1] ?? "").toLowerCase();
    if (user !== "testuser") return true;
  }
  return false;
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
