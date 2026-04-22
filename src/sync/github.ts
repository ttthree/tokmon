import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureTokmonDirectories, getGitHubSyncStatePath, getRemoteMachinesDirectory, loadConfig } from "../core/config.js";
import { loadMachineData } from "../core/data.js";
import { getMachineId } from "../core/machine.js";
import { redactForSync } from "../core/privacy.js";
import type { GitHubConfig, PrivacyConfig, SyncResult } from "../core/types.js";

const execFileAsync = promisify(execFile);

interface GitHubSyncState {
  branch: string;
  lastSuccessfulSyncAt: string;
  repo: string;
}

export function resolveGitCloneTarget(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/i, "");
  if (/^[^@:\s/]+\/[^@:\s/]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  return repo.trim();
}

export function getRepoCacheKey(repo: string): string {
  const key = repo.trim().replace(/\.git$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return key || "repo";
}

export function buildLatestSnapshotPushArgs(branch: string, remoteHead: string): string[] {
  return ["push", `--force-with-lease=refs/heads/${branch}:${remoteHead}`, "origin", `HEAD:refs/heads/${branch}`];
}

export function isGitHubSyncDue(github: GitHubConfig, state: GitHubSyncState | null, nowMs: number = Date.now()): boolean {
  if (!github.repo.trim()) {
    return false;
  }
  if (!state || state.repo !== github.repo || state.branch !== github.branch) {
    return true;
  }
  const lastSyncMs = Date.parse(state.lastSuccessfulSyncAt);
  if (!Number.isFinite(lastSyncMs)) {
    return true;
  }
  return nowMs - lastSyncMs >= github.syncIntervalMinutes * 60 * 1000;
}

export async function syncIfDue(github: GitHubConfig, nowMs: number = Date.now()): Promise<SyncResult | null> {
  const state = await loadGitHubSyncState();
  if (!isGitHubSyncDue(github, state, nowMs)) {
    return null;
  }
  const result = await sync();
  await saveGitHubSyncState({
    repo: github.repo,
    branch: github.branch,
    lastSuccessfulSyncAt: new Date(nowMs).toISOString(),
  });
  return result;
}

export async function createLatestSnapshotCommit(repoDir: string, message: string): Promise<void> {
  await execGit(["-C", repoDir, "checkout", "--orphan", "tokmon-sync-snapshot"]);
  await execGit(["-C", repoDir, "add", "-A"]);
  await execGit(["-C", repoDir, "commit", "-m", message]);
}

export async function sync(): Promise<SyncResult> {
  const config = await loadConfig();
  const machineId = await getMachineId();
  const cloneTarget = resolveGitCloneTarget(config.github.repo);
  const commitMessage = `sync: ${machineId} @ ${new Date().toISOString()}`;

  await ensureTokmonDirectories();

  const repoDir = path.join(os.tmpdir(), "tokmon-sync", getRepoCacheKey(config.github.repo));
  await fs.mkdir(path.dirname(repoDir), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await fs.rm(repoDir, { recursive: true, force: true });
    try {
      const prepared = await prepareLatestSnapshot({
        branch: config.github.branch,
        cloneTarget,
        commitMessage,
        machineId,
        privacy: config.privacy,
        repoDir,
        repoLabel: config.github.repo,
      });

      if (!prepared.pushed) {
        return { pulled: prepared.pulled, pushed: false };
      }

      await timed(`git push snapshot (attempt ${attempt + 1})`, () =>
        execGit(["-C", repoDir, ...buildLatestSnapshotPushArgs(config.github.branch, prepared.remoteHead)]),
      );
      return { pulled: prepared.pulled, pushed: true };
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  }

  return { pulled: 0, pushed: false };
}

export async function syncInit(): Promise<void> {
  const config = await loadConfig();
  const cloneTarget = resolveGitCloneTarget(config.github.repo);
  const repoDir = path.join(os.tmpdir(), "tokmon-sync-check", getRepoCacheKey(config.github.repo));
  await fs.rm(repoDir, { recursive: true, force: true });
  try {
    await execGit(["clone", "--depth=1", "--branch", config.github.branch, cloneTarget, repoDir]);
    console.log("Successfully authenticated with GitHub.");
    console.log("Sync initialized. Run `tokmon sync` to sync data.");
  } catch (error) {
    console.error("Failed to access repo. Ensure the repo exists, you have push access, and Git credentials (HTTPS helper or SSH) are configured.");
    throw error;
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
}

async function prepareLatestSnapshot(options: {
  branch: string;
  cloneTarget: string;
  commitMessage: string;
  machineId: string;
  privacy: PrivacyConfig;
  repoDir: string;
  repoLabel: string;
}): Promise<{ pulled: number; pushed: boolean; remoteHead: string }> {
  await timed(`git clone ${options.repoLabel}#${options.branch}`, () =>
    execGit(["clone", "--depth=1", "--branch", options.branch, options.cloneTarget, options.repoDir]),
  );

  const repoMachinesDir = path.join(options.repoDir, "machines");
  const localRemoteDir = getRemoteMachinesDirectory();
  await fs.mkdir(repoMachinesDir, { recursive: true });
  await fs.mkdir(localRemoteDir, { recursive: true });

  let pulled = 0;
  for (const file of await fs.readdir(repoMachinesDir).catch(() => [])) {
    if (!file.endsWith(".json") || file === `${options.machineId}.json`) {
      continue;
    }
    await fs.copyFile(path.join(repoMachinesDir, file), path.join(localRemoteDir, file));
    pulled += 1;
  }

  const localMachineData = await loadMachineData(options.machineId);
  const redacted = redactForSync(localMachineData, options.privacy);
  const repoMachinePath = path.join(repoMachinesDir, `${options.machineId}.json`);
  const repoMachineTmp = `${repoMachinePath}.tmp`;
  await fs.writeFile(repoMachineTmp, JSON.stringify(redacted, null, 2) + "\n", "utf8");
  await fs.rename(repoMachineTmp, repoMachinePath);

  await execGit(["-C", options.repoDir, "add", `machines/${options.machineId}.json`]);
  const status = await execGit(["-C", options.repoDir, "status", "--porcelain"]);
  if (status.trim().length === 0) {
    return { pulled, pushed: false, remoteHead: "" };
  }

  const remoteHead = (await execGit(["-C", options.repoDir, "rev-parse", `refs/remotes/origin/${options.branch}`])).trim();
  await createLatestSnapshotCommit(options.repoDir, options.commitMessage);
  return { pulled, pushed: true, remoteHead };
}

async function loadGitHubSyncState(): Promise<GitHubSyncState | null> {
  try {
    const raw = JSON.parse(await fs.readFile(getGitHubSyncStatePath(), "utf8")) as Partial<GitHubSyncState>;
    if (typeof raw.repo !== "string" || typeof raw.branch !== "string" || typeof raw.lastSuccessfulSyncAt !== "string") {
      return null;
    }
    return {
      repo: raw.repo,
      branch: raw.branch,
      lastSuccessfulSyncAt: raw.lastSuccessfulSyncAt,
    };
  } catch {
    return null;
  }
}

async function saveGitHubSyncState(state: GitHubSyncState): Promise<void> {
  await ensureTokmonDirectories();
  await fs.writeFile(getGitHubSyncStatePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function execGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  process.stdout.write(`    ↳ ${label}…`);
  try {
    const result = await fn();
    const ms = Date.now() - start;
    process.stdout.write(` (${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`})\n`);
    return result;
  } catch (error) {
    const ms = Date.now() - start;
    process.stdout.write(` FAILED after ${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}\n`);
    throw error;
  }
}
