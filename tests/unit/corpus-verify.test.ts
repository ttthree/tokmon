import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyCorpus } from "../../src/cli/commands/corpus/verify.js";

let tempRoot = "";

afterEach(async () => {
  if (!tempRoot) return;
  await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("verifyCorpus", () => {
  it("does not require mars sessions for mars-trees metadata", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-verify-"));
    const corpusRoot = path.join(tempRoot, "corpus");
    const homeDir = path.join(corpusRoot, "home");

    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      path.join(corpusRoot, "manifest.json"),
      JSON.stringify({ id: "corpus", epoch: 0, sourceCounts: { "mars-trees": 1 } }, null, 2) + "\n",
      "utf8",
    );

    await expect(verifyCorpus(corpusRoot)).resolves.toBeUndefined();
  });
});
