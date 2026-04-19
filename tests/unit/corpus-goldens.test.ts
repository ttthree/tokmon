import { describe, expect, it } from "vitest";

import corporaRegistry from "../corpus/corpora.json" with { type: "json" };
import { loadGoldens } from "../e2e/helpers/corpus-goldens.js";

const CORPUS_IDS = corporaRegistry.corpora.map((corpus) => corpus.id);

describe("loadGoldens helper", () => {
  it.each(CORPUS_IDS)("loads goldens for %s with expected shape", async (corpusId) => {
    const goldens = await loadGoldens(corpusId);

    expect(typeof goldens.manifest.epoch).toBe("number");
    expect(Number.isFinite(goldens.aggregates.totals.cost.total)).toBe(true);
    expect(Array.isArray(goldens.aggregates.projects)).toBe(true);

    expect(goldens.attribution).toHaveProperty("summary");
    expect(goldens.attribution).toHaveProperty("eurekaLinkage");
    expect(goldens.attribution).toHaveProperty("claimedCcSessionIds");
  });
});
