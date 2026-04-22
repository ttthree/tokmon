import fs from "node:fs/promises";
import path from "node:path";

export interface Manifest {
  id: string;
  epoch: number;
  fileMtimes?: Record<string, number>;
}

export interface LoadedCorpus {
  id: string;
  manifest: Manifest;
  root: string;
  homeDir: string;
  goldenDir: string;
}

let corpusEnvLock: Promise<void> = Promise.resolve();

export async function listCorpora(): Promise<Array<{ id: string; root: string }>> {
  const registryPath = path.resolve("tests/corpus/corpora.json");
  const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as { corpora: Array<{ id: string; path: string }> };
  return raw.corpora.map((c) => ({ id: c.id, root: path.resolve(c.path) }));
}

export async function loadCorpus(id: string): Promise<LoadedCorpus> {
  const corpora = await listCorpora();
  const found = corpora.find((c) => c.id === id);
  if (!found) throw new Error(`Corpus not found: ${id}`);
  const manifest = JSON.parse(await fs.readFile(path.join(found.root, "manifest.json"), "utf8")) as Manifest;
  return {
    id,
    manifest,
    root: found.root,
    homeDir: path.join(found.root, "home"),
    goldenDir: path.join(found.root, "golden"),
  };
}

export async function withCorpusEnv<T>(corpus: LoadedCorpus, fn: () => Promise<T>): Promise<T> {
  const prior = corpusEnvLock;
  let release: () => void = () => {};
  corpusEnvLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await prior;
  const prevHome = process.env.TOKMON_HOME;
  const prevDisableConfigSave = process.env.TOKMON_DISABLE_CONFIG_SAVE;
  const prevDisableDiag = process.env.TOKMON_DISABLE_DIAG_LOG;
  process.env.TOKMON_HOME = corpus.homeDir;
  process.env.TOKMON_DISABLE_CONFIG_SAVE = "1";
  process.env.TOKMON_DISABLE_DIAG_LOG = "1";
  // Mtimes are restored once per run by tests/corpus/global-setup.ts to
  // avoid concurrent fs.utimes calls across vitest workers (which race
  // on Windows).
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.TOKMON_HOME;
    else process.env.TOKMON_HOME = prevHome;
    if (prevDisableConfigSave === undefined) delete process.env.TOKMON_DISABLE_CONFIG_SAVE;
    else process.env.TOKMON_DISABLE_CONFIG_SAVE = prevDisableConfigSave;
    if (prevDisableDiag === undefined) delete process.env.TOKMON_DISABLE_DIAG_LOG;
    else process.env.TOKMON_DISABLE_DIAG_LOG = prevDisableDiag;
    release();
  }
}
