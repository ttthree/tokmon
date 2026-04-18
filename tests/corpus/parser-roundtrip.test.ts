import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseAllPure } from "../../src/cli/commands/corpus/parse-pure.js";
import { normalizeForGolden } from "../../src/cli/commands/corpus/regenerate-golden.js";
import { listCorpora, loadCorpus, withCorpusEnv } from "./helpers/load-corpus.js";

const corpora = await listCorpora();

describe.each(corpora)("corpus $id", ({ id }) => {
  it("parses to golden sessions.json", async () => {
    const corpus = await loadCorpus(id);
    await withCorpusEnv(corpus, async () => {
      const sessions = await parseAllPure({ forceAllSources: true });
      const normalized = normalizeForGolden(sessions, corpus.manifest.epoch);
      const goldenPath = path.join(corpus.goldenDir, "sessions.json");
      const golden = JSON.parse(await fs.readFile(goldenPath, "utf8"));
      expect(normalized).toEqual(golden);
    });
  }, 30000);
});
