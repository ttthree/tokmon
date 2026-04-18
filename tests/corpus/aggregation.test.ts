import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { parseAllPure } from "../../src/cli/commands/corpus/parse-pure.js";
import { normalizeForGolden } from "../../src/cli/commands/corpus/regenerate-golden.js";
import { aggregateFromSessions, type AggregatesGolden } from "./helpers/aggregate-from-sessions.js";
import { listCorpora, loadCorpus, withCorpusEnv } from "./helpers/load-corpus.js";

const corpora = await listCorpora();

describe.each(corpora)("aggregation: $id", ({ id }) => {
  let actual: AggregatesGolden;
  let golden: AggregatesGolden;

  beforeAll(async () => {
    const corpus = await loadCorpus(id);
    await withCorpusEnv(corpus, async () => {
      const sessions = await parseAllPure({ forceAllSources: true });
      actual = normalizeForGolden(aggregateFromSessions(sessions), corpus.manifest.epoch);
    });
    golden = JSON.parse(await fs.readFile(path.join(corpus.goldenDir, "aggregates.json"), "utf8")) as AggregatesGolden;
  }, 30000);

  it("matches totals", () => expect(actual.totals).toEqual(golden.totals));
  it("matches per-source", () => expect(actual.perSource).toEqual(golden.perSource));
  it("matches per-model", () => expect(actual.perModel).toEqual(golden.perModel));
  it("matches per-mars-task", () => expect(actual.perMarsTask).toEqual(golden.perMarsTask));
  it("matches per-day", () => expect(actual.perDay).toEqual(golden.perDay));
  it("matches projects", () => expect(actual.projects).toEqual(golden.projects));
  it("matches leaderboards", () => expect(actual.leaderboards).toEqual(golden.leaderboards));
});
