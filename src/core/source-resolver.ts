import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getClaudeDirectory, getCodexDirectory } from "./config.js";
import type { Session } from "./types.js";

export async function resolveSourcePath(session: Session): Promise<string | null> {
  if (session.source === "claude-code") {
    return resolveClaudeCodePath(session);
  }

  if (session.source === "eureka") {
    return resolveEurekaPath(session);
  }

  if (session.source === "codex") {
    return resolveCodexPath(session);
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

async function resolveCodexPath(session: Session): Promise<string | null> {
  // Codex rollout files: ~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-{threadId}.jsonl
  const sessionsDir = path.join(getCodexDirectory(), "sessions");
  try {
    const match = await findCodexRollout(sessionsDir, session.id);
    return match;
  } catch {
    return null;
  }
}

async function findCodexRollout(dir: string, sessionId: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findCodexRollout(full, sessionId);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) {
      return full;
    }
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
