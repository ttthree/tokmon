import { exec } from "node:child_process";

import { isSyncConfigured, loadConfig } from "../../core/config.js";
import type { AppConfig } from "../../core/types.js";
import { serve } from "../../server/index.js";
import { sync } from "../../sync/github.js";
import { collectCommand } from "./collect.js";

export interface RunOptions {
  port: number;
  open: boolean;
  reset: boolean;
}

let refreshRunning = false;

export async function run(options: RunOptions): Promise<void> {
  const collectResult = await collectCommand({ reset: options.reset });
  const elapsed = (collectResult.durationMs / 1000).toFixed(1);
  console.log(`✓ Collected ${collectResult.sessionCount} sessions (${elapsed}s)`);

  const config = await loadConfig();
  if (isSyncConfigured(config)) {
    try {
      const result = await sync();
      console.log(`✓ Synced with GitHub (pulled ${result.pulled}, pushed=${result.pushed})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`⚠ GitHub sync failed: ${message}`);
    }
  }

  await serve(options.port);
  console.log(`● Dashboard → http://localhost:${options.port}`);

  if (options.open) {
    openBrowser(`http://localhost:${options.port}`);
  }

  startBackgroundRefresh(config);
}

export function startBackgroundRefresh(config: AppConfig): NodeJS.Timeout {
  return setInterval(async () => {
    if (refreshRunning) {
      return;
    }
    refreshRunning = true;
    try {
      await collectCommand();
      if (isSyncConfigured(config)) {
        await sync();
      }
    } catch {
      // Background refresh failures are intentionally silent.
    } finally {
      refreshRunning = false;
    }
  }, 5 * 60 * 1000);
}

export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? `open ${url}` : process.platform === "win32" ? `start ${url}` : `xdg-open ${url}`;
  exec(command, () => {
    // Browser launch failures are intentionally silent.
  });
}

export function resetBackgroundRefreshState(): void {
  refreshRunning = false;
}
