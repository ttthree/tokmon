import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import corporaRegistry from "../corpus/corpora.json" with { type: "json" };
import { serveCorpus, type CorpusServer } from "../e2e/helpers/serve-corpus.js";

const CORPUS_IDS = corporaRegistry.corpora.map((corpus) => corpus.id);
const activeServers: CorpusServer[] = [];

afterAll(async () => {
  for (const server of activeServers.splice(0)) {
    await server.close();
  }
});

describe("serveCorpus helper", () => {
  it.each(CORPUS_IDS)("boots and serves corpus %s", async (corpusId) => {
    const server = await serveCorpus(corpusId, { timeoutMs: 60_000 });
    activeServers.push(server);

    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);

    const response = await fetch(`${server.url}/api/data`);
    expect(response.ok).toBe(true);

    const body = await response.json() as { totals?: { sessions?: number } };
    expect(typeof body?.totals?.sessions).toBe("number");

    const machineFiles = await fs.readdir(path.join(server.homePath, ".tokmon", "machines"));
    expect(machineFiles.some((file) => file.endsWith(".json"))).toBe(true);
  }, 90_000);
});
