import fs from "node:fs/promises";
import path from "node:path";

import { aggregateFromSessions } from "./helpers/aggregate-from-sessions.js";
import { buildAttribution } from "./helpers/build-attribution.js";
import { parseAllPure } from "../../src/cli/commands/corpus/parse-pure.js";
import {
  normalizeForGolden,
  regenerateGolden,
} from "../../src/cli/commands/corpus/regenerate-golden.js";

interface Manifest {
  epoch: number;
  fileMtimes?: Record<string, number>;
}

export async function regenerateCorpusGoldens(corpusRoot: string): Promise<void> {
  const root = path.resolve(corpusRoot);
  await regenerateGolden(root);

  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) as Manifest;
  await restoreMtimes(root, manifest.fileMtimes ?? {});

  const prevHome = process.env.TOKMON_HOME;
  process.env.TOKMON_HOME = path.join(root, "home");
  try {
    const sessions = await parseAllPure({ forceAllSources: true });
    const goldenDir = path.join(root, "golden");
    await fs.mkdir(goldenDir, { recursive: true });
    await writeGolden(goldenDir, "attribution.json", normalizeForGolden(buildAttribution(sessions), manifest.epoch));
    await writeGolden(goldenDir, "aggregates.json", normalizeForGolden(aggregateFromSessions(sessions), manifest.epoch));
  } finally {
    if (prevHome === undefined) delete process.env.TOKMON_HOME;
    else process.env.TOKMON_HOME = prevHome;
  }
}

async function writeGolden(dir: string, name: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function restoreMtimes(root: string, fileMtimes: Record<string, number>): Promise<void> {
  for (const [relPath, mtimeMs] of Object.entries(fileMtimes)) {
    const full = path.join(root, relPath);
    const sec = mtimeMs / 1000;
    await fs.utimes(full, sec, sec).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const corpusIndex = process.argv.indexOf("--corpus");
  if (corpusIndex === -1 || !process.argv[corpusIndex + 1]) {
    throw new Error("Usage: tsx tests/corpus/regenerate-golden.ts --corpus <dir>");
  }
  await regenerateCorpusGoldens(process.argv[corpusIndex + 1]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
