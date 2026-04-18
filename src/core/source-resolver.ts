import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getClaudeDirectory, getCodexDirectory, getCopilotDirectory } from "./config.js";
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

  if (session.source === "copilot-cli") {
    return resolveCopilotCliPath(session);
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
  const workspacesDirs = [
    path.join(os.homedir(), ".craft-agent", "workspaces"),
    path.join(os.homedir(), ".eureka", "workspaces"),
  ];
  for (const workspacesDir of workspacesDirs) {
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

async function resolveCopilotCliPath(session: Session): Promise<string | null> {
  // Copilot CLI conversation data is in ~/.copilot/session-store.db `turns` table.
  // We return the DB path only if it exists and has turns for this session.
  const dbPath = path.join(getCopilotDirectory(), "session-store.db");
  try {
    await fs.access(dbPath);
    return dbPath;
  } catch {
    return null;
  }
}

export function encodeClaudeProjectPath(projectPath: string): string | null {
  if (!projectPath.trim()) {
    return null;
  }

  // Mirror Claude Code's on-disk encoding: every path separator ('/' or '\'),
  // drive-letter colons AND dots get replaced with '-'. The dot replacement
  // matters for paths like "/Users/foo/.craft-agent/..." which CC stores as
  // "-Users-foo--craft-agent-..." (note the double dash). Forgetting to
  // replace '.' caused token totals for Eureka sessions whose sdkCwd contained
  // dotted segments to silently drop to zero on incremental collects.
  const normalized = projectPath.trim().replace(/\\/g, "/");
  return normalized.replace(/\//g, "-").replace(/:/g, "-").replace(/\./g, "-");
}
