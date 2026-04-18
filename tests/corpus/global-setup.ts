import { spawn } from "node:child_process";
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
  const registryPath = path.resolve("tests/corpus/corpora.json");
  const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
    corpora: Array<{ id: string; path: string }>;
  };
  for (const corpus of raw.corpora) {
    const corpusRoot = path.resolve(corpus.path);
    const homeDir = path.join(corpusRoot, "home");
    const manifest = JSON.parse(
      await fs.readFile(path.join(corpusRoot, "manifest.json"), "utf8"),
    ) as { fileMtimes?: Record<string, number> };
    const fileMtimes = manifest.fileMtimes ?? {};
    let stagedFiles = 0;
    if (process.platform !== "darwin") {
      stagedFiles = await stageMarsAppSupport(homeDir, fileMtimes);
    }
    // Restore mtimes for the original snapshot tree once per run.
    // withCorpusEnv would otherwise race across vitest workers on Windows;
    // utimes errors there are silently swallowed and many parsers
    // (e.g. claude-code) fall back to fileMtime, producing today's
    // timestamps instead of the corpus's recorded ones.
    const restored = await restoreMtimes(corpusRoot, fileMtimes);
    // eslint-disable-next-line no-console
    console.log(
      `[corpus globalSetup] ${corpus.id} platform=${process.platform} staged=${stagedFiles} mtimesRestored=${restored}/${Object.keys(fileMtimes).length}`,
    );
  }
}

async function restoreMtimes(
  corpusRoot: string,
  fileMtimes: Record<string, number>,
): Promise<number> {
  let restored = 0;
  for (const [relPath, mtimeMs] of Object.entries(fileMtimes)) {
    const full = path.join(corpusRoot, relPath);
    const sec = mtimeMs / 1000;
    try {
      await fs.utimes(full, sec, sec);
      restored++;
    } catch {
      // ignore: not all manifest entries map to platform-relevant files
    }
  }
  if (process.platform === "win32") {
    // fs.utimes does not touch CreationTime on Windows, but the
    // claude-code parser falls back to stat.birthtimeMs for the
    // session createdAt when no explicit timestamp is in the JSONL
    // header. Use PowerShell's [IO.File]::SetCreationTime to align
    // birthtime with mtime so corpus parsing is deterministic.
    const abs: Record<string, number> = {};
    for (const [relPath, mtimeMs] of Object.entries(fileMtimes)) {
      abs[path.join(corpusRoot, relPath)] = mtimeMs;
    }
    await setWindowsBirthtimesAbs(abs);
  }
  return restored;
}

async function setWindowsBirthtimesAbs(
  abs: Record<string, number>,
): Promise<void> {
  // Build a single PowerShell call that sets CreationTime for every
  // path. Spawning per-file would be far too slow on Windows.
  const lines: string[] = [];
  for (const [full, mtimeMs] of Object.entries(abs)) {
    const iso = new Date(mtimeMs).toISOString();
    const escaped = full.replace(/'/g, "''");
    lines.push(`try { [IO.File]::SetCreationTime('${escaped}', [DateTime]::Parse('${iso}').ToUniversalTime()) } catch {}`);
  }
  if (lines.length === 0) return;
  const script = lines.join("\n");
  await new Promise<void>((resolve) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "-"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    proc.on("error", () => resolve());
    proc.on("exit", () => resolve());
    proc.stdin.end(script);
  });
}

const MAC_PREFIX = path.join("Library", "Application Support") + path.sep;

async function stageMarsAppSupport(
  homeDir: string,
  fileMtimes: Record<string, number>,
): Promise<number> {
  const macRoot = path.join(homeDir, "Library", "Application Support");
  const macExists = await fs.stat(macRoot).then((s) => s.isDirectory(), () => false);
  if (!macExists) return 0;

  const targetRoot = process.platform === "win32"
    ? path.join(homeDir, "AppData", "Roaming")
    : path.join(homeDir, ".config");
  const marker = path.join(targetRoot, ".tokmon-mars-staged");
  if (await fs.stat(marker).then(() => true, () => false)) return -1;

  await fs.mkdir(targetRoot, { recursive: true });
  const apps = await fs.readdir(macRoot, { withFileTypes: true });
  for (const entry of apps) {
    if (!entry.isDirectory()) continue;
    const src = path.join(macRoot, entry.name);
    const dst = path.join(targetRoot, entry.name);
    await fs.cp(src, dst, { recursive: true, force: true });
  }

  // Restore mtimes on the staged copies. The manifest only references
  // the macOS-shaped paths; translate any entry under
  // `home/Library/Application Support/` to its staged equivalent so
  // parsers that fall back to fileMtime (e.g. claude-code) get the
  // same timestamp on Windows/Linux as on macOS.
  let stagedRestored = 0;
  const stagedMtimes: Record<string, number> = {};
  for (const [relPath, mtimeMs] of Object.entries(fileMtimes)) {
    const platformRel = relPath.split("/").join(path.sep);
    const homeRelPrefix = "home" + path.sep + MAC_PREFIX;
    if (!platformRel.startsWith(homeRelPrefix)) continue;
    const tail = platformRel.slice(homeRelPrefix.length);
    const stagedAbs = path.join(targetRoot, tail);
    const sec = mtimeMs / 1000;
    try {
      await fs.utimes(stagedAbs, sec, sec);
      stagedRestored++;
      // Track for birthtime pass below.
      stagedMtimes[stagedAbs] = mtimeMs;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[corpus globalSetup] utimes failed: ${stagedAbs}: ${(err as Error).message}`);
    }
  }
  if (process.platform === "win32" && Object.keys(stagedMtimes).length > 0) {
    await setWindowsBirthtimesAbs(stagedMtimes);
  }

  await fs.writeFile(marker, "", "utf8");
  return stagedRestored;
}
