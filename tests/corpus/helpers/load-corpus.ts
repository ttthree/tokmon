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
  process.env.TOKMON_HOME = corpus.homeDir;
  await restoreMtimes(corpus.root, corpus.manifest.fileMtimes ?? {});
  await stageMarsAppSupport(corpus.homeDir);
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.TOKMON_HOME;
    else process.env.TOKMON_HOME = prevHome;
    release();
  }
}

// Snapshots are captured on macOS and store the Mars data dir under
// `Library/Application Support/com.marsiwe.app{,.dev}`. Production code
// looks under `%APPDATA%\com.marsiwe.app` on Windows and
// `$XDG_CONFIG_HOME/com.marsiwe.app` on Linux. To keep the snapshots
// platform-agnostic without rewriting them, mirror the macOS subtree to
// the platform-appropriate location at test time.
//
// Idempotent: a marker file records that staging is complete so repeated
// `withCorpusEnv` calls don't re-copy thousands of files.
async function stageMarsAppSupport(homeDir: string): Promise<void> {
  if (process.platform === "darwin") return;
  const macRoot = path.join(homeDir, "Library", "Application Support");
  const macExists = await fs.stat(macRoot).then((s) => s.isDirectory(), () => false);
  if (!macExists) return;

  const targetRoot = process.platform === "win32"
    ? path.join(homeDir, "AppData", "Roaming")
    : path.join(homeDir, ".config");
  const marker = path.join(targetRoot, ".tokmon-mars-staged");
  if (await fs.stat(marker).then(() => true, () => false)) return;

  await fs.mkdir(targetRoot, { recursive: true });

  const apps = await fs.readdir(macRoot, { withFileTypes: true });
  for (const entry of apps) {
    if (!entry.isDirectory()) continue;
    const src = path.join(macRoot, entry.name);
    const dst = path.join(targetRoot, entry.name);
    // fs.cp recursive is more reliable on Windows than a manual readdir+copy.
    await fs.cp(src, dst, { recursive: true, force: true });
  }
  await fs.writeFile(marker, "", "utf8");
}

async function restoreMtimes(root: string, mtimes: Record<string, number>): Promise<void> {
  for (const [relPath, mtimeMs] of Object.entries(mtimes)) {
    const full = path.join(root, relPath);
    const sec = mtimeMs / 1000;
    await fs.utimes(full, sec, sec).catch(() => undefined);
  }
}
