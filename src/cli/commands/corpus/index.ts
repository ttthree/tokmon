import { Command } from "commander";

import { registerCorpusRegenerateGolden } from "./regenerate-golden.js";
import { registerCorpusSample } from "./sample.js";
import { registerCorpusSanitize } from "./sanitize.js";
import { registerCorpusVerify } from "./verify.js";

export function registerCorpusCommands(program: Command): void {
  const corpus = program.command("corpus", { hidden: true }).description("Corpus tooling for test harness");
  registerCorpusSample(corpus);
  registerCorpusSanitize(corpus);
  registerCorpusVerify(corpus);
  registerCorpusRegenerateGolden(corpus);
}

