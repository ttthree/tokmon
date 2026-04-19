import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { parseAllPure } from "../../src/cli/commands/corpus/parse-pure.js";
import { normalizeForGolden } from "../../src/cli/commands/corpus/regenerate-golden.js";
import { buildAttribution, type AttributionGolden } from "./helpers/build-attribution.js";
import { listCorpora, loadCorpus, withCorpusEnv } from "./helpers/load-corpus.js";

const corpora = await listCorpora();

describe.each(corpora)("attribution: $id", ({ id }) => {
  let actual: AttributionGolden;
  let golden: AttributionGolden;

  beforeAll(async () => {
    const corpus = await loadCorpus(id);
    await withCorpusEnv(corpus, async () => {
      const sessions = await parseAllPure({ forceAllSources: true });
      actual = normalizeForGolden(buildAttribution(sessions), corpus.manifest.epoch);
    });
    golden = JSON.parse(await fs.readFile(path.join(corpus.goldenDir, "attribution.json"), "utf8")) as AttributionGolden;
  }, 30000);

  it("matches summary counts", () => {
    expect(actual.summary).toEqual(golden.summary);
  });

  it("matches eureka linkage", () => {
    expect(actual.eurekaLinkage).toEqual(golden.eurekaLinkage);
  });

  it("matches mars trees", () => {
    expect(actual.marsTrees).toEqual(golden.marsTrees);
  });

  it("has no double-counting", () => {
    expect(actual.doubleCounting.duplicateSessionKeys).toEqual([]);
  });
});
