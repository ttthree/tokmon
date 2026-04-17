import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { minimatch } from "minimatch";

import type { ProjectConfig } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Normalize a project path by resolving worktree paths to their parent project.
 * e.g., /Users/jietong/work/MarsIWE/.worktrees/438b434c-... -> /Users/jietong/work/MarsIWE
 * Also handles .codex/worktrees/NNNN/project-name -> extracts project-name as basename.
 */
export function normalizeProjectPath(projectPath: string): string {
  // Normalize double slashes first
  const cleaned = projectPath.replace(/\/\//g, "/");

  // Codex worktrees: ~/.codex/worktrees/XXXX/project-name — return project-name as
  // basename. Worktree IDs can be hex (e.g. 62f7), not just numeric.
  const codexMatch = cleaned.match(/\/\.codex\/worktrees\/[0-9a-f]+\/([^/]+)/);
  if (codexMatch) {
    return codexMatch[1];
  }

  const worktreeIndex = cleaned.indexOf("/.worktrees/");
  if (worktreeIndex >= 0) {
    return cleaned.slice(0, worktreeIndex);
  }
  // Also handle /worktrees/ (without dot) — some tools use this variant
  const plainWorktreeIndex = cleaned.indexOf("/worktrees/");
  if (plainWorktreeIndex >= 0) {
    return cleaned.slice(0, plainWorktreeIndex);
  }
  return cleaned;
}

export function matchesPattern(candidatePath: string, pattern: string): boolean {
  if (pattern.startsWith("/")) {
    return minimatch(candidatePath, pattern, { dot: true });
  }

  const basename = path.basename(candidatePath);
  if (!pattern.includes("/")) {
    return minimatch(basename, pattern, { dot: true });
  }

  return minimatch(candidatePath, `**/${pattern}`, { dot: true });
}

export async function resolveProject(sessionPath: string, config: ProjectConfig): Promise<string> {
  // Normalize worktree paths to their parent project first
  const normalized = normalizeProjectPath(sessionPath);

  for (const [name, definition] of Object.entries(config.projects)) {
    for (const pattern of definition.folders) {
      if (matchesPattern(normalized, pattern)) {
        return name;
      }
    }
  }

  for (const pattern of config.excludeFolders) {
    if (matchesPattern(normalized, pattern)) {
      return "other";
    }
  }

  const repoName = await extractGitRepoName(normalized);
  if (repoName) {
    return repoName;
  }

  const folderName = path.basename(normalized);
  if (folderName && folderName !== "/" && folderName !== ".") {
    return folderName;
  }

  return "other";
}

export async function extractGitRepoName(sessionPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", sessionPath, "config", "--get", "remote.origin.url"]);
    const remote = stdout.trim();
    if (!remote) {
      return null;
    }

    const match = remote.match(/([^/:]+)\/?([^/]+?)(?:\.git)?$/);
    return match?.[2] ?? null;
  } catch {
    return null;
  }
}
