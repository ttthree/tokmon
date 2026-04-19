import fs from "node:fs/promises";
import path from "node:path";

import { getMarsAppSupportDirectories } from "./config.js";
import type { ParserContext } from "./types.js";

export interface ParseRoots {
  claudeRoots: string[];
  codexRoots: string[];
  copilotRoots: string[];
}

export async function discoverParseRoots(context: ParserContext): Promise<ParseRoots> {
  const enabledMars = (context.sources ?? [])
    .filter((source) => source.enabled && source.type === "mars")
    .map((source) => source.path);
  const appSupportDirs = enabledMars.length > 0 ? enabledMars : getMarsAppSupportDirectories();
  const roots: ParseRoots = {
    claudeRoots: [],
    codexRoots: [],
    copilotRoots: [],
  };

  for (const appDir of appSupportDirs) {
    await maybeAddRoot(path.join(appDir, "agent-configs", "claude"), roots.claudeRoots);
    await maybeAddRoot(path.join(appDir, "agent-configs", "codex"), roots.codexRoots);
    await maybeAddRoot(path.join(appDir, "agent-configs", "copilot"), roots.copilotRoots);
  }

  return roots;
}

async function maybeAddRoot(dir: string, roots: string[]): Promise<void> {
  const stat = await safeStat(dir);
  if (stat?.isDirectory()) {
    roots.push(dir);
  }
}

async function safeStat(target: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}
