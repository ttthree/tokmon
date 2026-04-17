import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getClaudeDirectory } from "./config.js";
import type { Session } from "./types.js";

export async function resolveSourcePath(session: Session): Promise<string | null> {
  if (session.source === "claude-code") {
    return resolveClaudeCodePath(session);
  }

  if (session.source === "eureka") {
    return resolveEurekaPath(session);
  }

  return null;
}

function resolveClaudeCodePath(session: Session): string | null {
  const encodedProjectPath = encodeClaudeProjectPath(session.projectPath);
  if (!encodedProjectPath) {
    return null;
  }

  return path.join(getClaudeDirectory(), "projects", encodedProjectPath, `${session.id}.jsonl`);
}

async function resolveEurekaPath(session: Session): Promise<string | null> {
  const workspacesDir = path.join(os.homedir(), ".craft-agent", "workspaces");
  try {
    const workspaces = await fs.readdir(workspacesDir);
    for (const workspace of workspaces) {
      const candidate = path.join(workspacesDir, workspace, "sessions", session.id, "session.jsonl");
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // not in this workspace, try next
      }
    }
  } catch {
    // workspaces dir doesn't exist
  }
  return null;
}

export function encodeClaudeProjectPath(projectPath: string): string | null {
  if (!projectPath.trim()) {
    return null;
  }

  const normalized = projectPath.trim().replace(/\\/g, "/");
  return normalized.replace(/\//g, "-");
}
