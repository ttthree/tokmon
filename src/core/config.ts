import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import type { AppConfig, MachineData } from "./types.js";

export const DEFAULT_CONFIG: AppConfig = {
  github: {
    repo: "",
    branch: "main",
  },
  privacy: {
    sync: {
      includeSummary: false,
      includeFirstPrompt: false,
      includeProjectPath: false,
      includeProjectName: true,
    },
  },
  projects: {},
  excludeFolders: ["/", "/tmp", "/private/var", ".worktrees", ".craft-agent", "workdirectory"],
  pricing: {
    autoUpdate: true,
    updateIntervalHours: 24,
  },
};

export function getHomeDirectory(): string {
  return process.env.TOKMON_HOME || os.homedir();
}

export function getTokmonDirectory(): string {
  return path.join(getHomeDirectory(), ".tokmon");
}

export function getConfigPath(): string {
  return path.join(getTokmonDirectory(), "config.json");
}

export function getMachineIdPath(): string {
  return path.join(getTokmonDirectory(), ".machine-id");
}

export function getLocalMachinesDirectory(): string {
  return path.join(getTokmonDirectory(), "machines");
}

export function getRemoteMachinesDirectory(): string {
  return path.join(getTokmonDirectory(), "remote");
}

export function getPricingDirectory(): string {
  return path.join(getTokmonDirectory(), "pricing");
}

export function getMachineDataPath(machineId: string): string {
  return path.join(getLocalMachinesDirectory(), `${machineId}.json`);
}

export function getClaudeDirectory(): string {
  return path.join(getHomeDirectory(), ".claude");
}

export function getCraftAgentClaudeDirectory(): string {
  return path.join(getHomeDirectory(), ".craft-agent", ".claude");
}

export function getAllClaudeDirectories(): string[] {
  return [getClaudeDirectory(), getCraftAgentClaudeDirectory()];
}

export function getCodexDirectory(): string {
  return path.join(getHomeDirectory(), ".codex");
}

export function getCopilotDirectory(): string {
  return path.join(getHomeDirectory(), ".copilot");
}

export async function ensureTokmonDirectories(): Promise<void> {
  await Promise.all([
    fs.mkdir(getTokmonDirectory(), { recursive: true }),
    fs.mkdir(getLocalMachinesDirectory(), { recursive: true }),
    fs.mkdir(getRemoteMachinesDirectory(), { recursive: true }),
    fs.mkdir(getPricingDirectory(), { recursive: true }),
  ]);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureTokmonDirectories();
  const configPath = getConfigPath();
  if (!(await pathExists(configPath))) {
    await saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<AppConfig>;
  return mergeConfig(DEFAULT_CONFIG, raw);
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await ensureTokmonDirectories();
  await fs.writeFile(getConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function setConfigValue(keyPath: string, value: unknown): Promise<AppConfig> {
  const config = await loadConfig();
  setNestedProperty(config as unknown as Record<string, unknown>, keyPath, value);
  await saveConfig(config);
  return config;
}

export async function loadMachineDataFromPath(machinePath: string): Promise<MachineData> {
  const raw = JSON.parse(await fs.readFile(machinePath, "utf8")) as MachineData;
  return raw;
}

export async function loadMachineDataFromPathSafe(machinePath: string): Promise<MachineData | null> {
  try {
    return await loadMachineDataFromPath(machinePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping malformed machine data file ${machinePath}: ${message}`);
    return null;
  }
}

export function isSyncConfigured(config: AppConfig): boolean {
  return config.github.repo.length > 0;
}

function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...override,
    github: {
      ...base.github,
      ...override.github,
    },
    privacy: {
      sync: {
        ...base.privacy.sync,
        ...override.privacy?.sync,
      },
    },
    projects: {
      ...base.projects,
      ...override.projects,
    },
    excludeFolders: override.excludeFolders ?? base.excludeFolders,
    pricing: {
      ...base.pricing,
      ...override.pricing,
    },
  };
}

function setNestedProperty(root: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split(".");
  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const current = cursor[part];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}
