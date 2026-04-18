import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadConfig, ensureTokmonDirectories, getRemoteMachinesDirectory } from "../core/config.js";
import { loadMachineData } from "../core/data.js";
import { getMachineId } from "../core/machine.js";
import { redactForSync } from "../core/privacy.js";
import type { SyncResult } from "../core/types.js";

const execFileAsync = promisify(execFile);

export async function sync(): Promise<SyncResult> {
  const config = await loadConfig();
  const machineId = await getMachineId();

  await ensureTokmonDirectories();

  const repoDir = path.join(os.tmpdir(), "tokmon-sync", config.github.repo.replaceAll("/", "-"));
  await fs.rm(repoDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  await execGit(["clone", "--depth=1", "--branch", config.github.branch, `https://github.com/${config.github.repo}.git`, repoDir]);

  const repoMachinesDir = path.join(repoDir, "machines");
  const localRemoteDir = getRemoteMachinesDirectory();
  await fs.mkdir(repoMachinesDir, { recursive: true });
  await fs.mkdir(localRemoteDir, { recursive: true });

  let pulled = 0;
  for (const file of await fs.readdir(repoMachinesDir).catch(() => [])) {
    if (!file.endsWith(".json") || file === `${machineId}.json`) {
      continue;
    }
    await fs.copyFile(path.join(repoMachinesDir, file), path.join(localRemoteDir, file));
    pulled += 1;
  }

  const localMachineData = await loadMachineData(machineId);
  const redacted = redactForSync(localMachineData, config.privacy);
  const repoMachinePath = path.join(repoMachinesDir, `${machineId}.json`);
  const repoMachineTmp = `${repoMachinePath}.tmp`;
  await fs.writeFile(repoMachineTmp, JSON.stringify(redacted, null, 2) + "\n", "utf8");
  await fs.rename(repoMachineTmp, repoMachinePath);

  await execGit(["-C", repoDir, "add", `machines/${machineId}.json`]);
  const status = await execGit(["-C", repoDir, "status", "--porcelain"]);
  const pushed = status.trim().length > 0;
  if (pushed) {
    await execGit(["-C", repoDir, "commit", "-m", `sync: ${machineId} @ ${new Date().toISOString()}`]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await execGit(["-C", repoDir, "push", "origin", config.github.branch]);
        break;
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
        await execGit(["-C", repoDir, "pull", "--rebase", "origin", config.github.branch]);
      }
    }
  }

  return { pulled, pushed };
}

export async function syncInit(): Promise<void> {
  const config = await loadConfig();
  const repoDir = path.join(os.tmpdir(), "tokmon-sync-check", config.github.repo.replaceAll("/", "-"));
  await fs.rm(repoDir, { recursive: true, force: true });
  try {
    await execGit(["clone", "--depth=1", "--branch", config.github.branch, `https://github.com/${config.github.repo}.git`, repoDir]);
    console.log("Successfully authenticated with GitHub.");
    console.log("Sync initialized. Run `tokmon sync` to sync data.");
  } catch (error) {
    console.error("Failed to access repo. Ensure the repo exists, you have push access, and Git credentials are configured.");
    throw error;
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
}

async function execGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}
