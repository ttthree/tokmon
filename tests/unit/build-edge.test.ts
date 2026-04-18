import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseAllPure } from "../../src/cli/commands/corpus/parse-pure.js";
import { buildAttribution } from "../corpus/helpers/build-attribution.js";
import { buildEdgeCorpus } from "../corpus/build-edge/build-edge.js";

let tempRoot = "";

afterEach(async () => {
  delete process.env.TOKMON_HOME;
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

describe("buildEdgeCorpus", () => {
  it("writes a parseable synthetic corpus under the size cap", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-edge-"));
    const corpusRoot = path.join(tempRoot, "2026-04-edge");

    await buildEdgeCorpus(corpusRoot);

    const manifest = JSON.parse(await fs.readFile(path.join(corpusRoot, "manifest.json"), "utf8")) as {
      totalBytes: number;
      fileMtimes: Record<string, number>;
    };

    expect(manifest.totalBytes).toBeLessThan(200 * 1024);
    expect(await exists(path.join(corpusRoot, "golden", "sessions.json"))).toBe(true);
    expect(await exists(path.join(corpusRoot, "golden", "attribution.json"))).toBe(true);
    expect(await exists(path.join(corpusRoot, "golden", "aggregates.json"))).toBe(true);

    process.env.TOKMON_HOME = path.join(corpusRoot, "home");
    await restoreMtimes(corpusRoot, manifest.fileMtimes);
    const sessions = await parseAllPure({ forceAllSources: true });
    const attribution = buildAttribution(sessions);

    expect(sessions.length).toBeGreaterThan(0);
    expect(attribution.summary.marsSessionCount).toBe(2);
    expect(attribution.eurekaLinkage.some((session) => session.resolved === false)).toBe(true);
  });
});

async function restoreMtimes(root: string, fileMtimes: Record<string, number>): Promise<void> {
  for (const [relPath, mtimeMs] of Object.entries(fileMtimes)) {
    const full = path.join(root, relPath);
    await fs.utimes(full, mtimeMs / 1000, mtimeMs / 1000).catch(() => undefined);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
