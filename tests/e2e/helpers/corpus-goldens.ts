import fs from "node:fs/promises";
import path from "node:path";

import { loadCorpus, type Manifest } from "../../corpus/helpers/load-corpus.js";
import type { AggregatesGolden } from "../../corpus/helpers/aggregate-from-sessions.js";
import type { AttributionGolden } from "../../corpus/helpers/build-attribution.js";

export interface CorpusGoldens {
  manifest: Manifest;
  aggregates: AggregatesGolden;
  sessions: unknown;
  attribution: AttributionGolden;
}

export async function loadGoldens(corpusId: string): Promise<CorpusGoldens> {
  const root = path.resolve(`tests/corpus/snapshots/${corpusId}`);
  const loaded = await loadCorpus(corpusId);
  const [aggregatesRaw, sessionsRaw, attributionRaw] = await Promise.all([
    fs.readFile(path.join(root, "golden", "aggregates.json"), "utf8"),
    fs.readFile(path.join(root, "golden", "sessions.json"), "utf8"),
    fs.readFile(path.join(root, "golden", "attribution.json"), "utf8"),
  ]);

  return {
    manifest: loaded.manifest,
    aggregates: JSON.parse(aggregatesRaw) as AggregatesGolden,
    sessions: JSON.parse(sessionsRaw),
    attribution: JSON.parse(attributionRaw) as AttributionGolden,
  };
}
