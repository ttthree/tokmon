import fs from "node:fs/promises";
import path from "node:path";

// Vitest globalSetup: runs once per `vitest run` invocation, before any
// worker forks. Used to stage the macOS-shaped Mars Application Support
// subtree under each corpus's `home/` to the platform-appropriate
// location so production code paths (which honor TOKMON_HOME) can find
// it on Windows / Linux without rewriting the snapshots.
//
// Doing the copy here (rather than inside `withCorpusEnv`) avoids races
// between vitest workers and keeps the per-test hook fast.
export default async function setup(): Promise<void> {
  if (process.platform === "darwin") return;

  const registryPath = path.resolve("tests/corpus/corpora.json");
  const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
    corpora: Array<{ id: string; path: string }>;
  };
  for (const corpus of raw.corpora) {
    const homeDir = path.join(path.resolve(corpus.path), "home");
    await stageMarsAppSupport(homeDir);
  }
}

async function stageMarsAppSupport(homeDir: string): Promise<void> {
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
    await fs.cp(src, dst, { recursive: true, force: true });
  }
  await fs.writeFile(marker, "", "utf8");
}
