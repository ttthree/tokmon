import { exec } from "node:child_process";

import { isSyncConfigured, loadConfig } from "../../core/config.js";
import type { AppConfig } from "../../core/types.js";
import { aggregateData } from "../../core/aggregate.js";
import { serve } from "../../server/index.js";
import { syncIfDue } from "../../sync/github.js";
import { collectCommand } from "./collect.js";

export interface RunOptions {
  port: number;
  open: boolean;
  reset: boolean;
  explicitPort?: boolean;
}

let refreshRunning = false;

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  console.log(`▶ ${label}…`);
  try {
    const result = await fn();
    console.log(`✓ ${label} (${fmt(Date.now() - start)})`);
    return result;
  } catch (error) {
    console.log(`✗ ${label} failed after ${fmt(Date.now() - start)}`);
    throw error;
  }
}

export async function run(options: RunOptions): Promise<void> {
  const overall = Date.now();

  const collectResult = await step("Collect sessions", () => collectCommand({ reset: options.reset }));
  console.log(`  → ${collectResult.sessionCount} sessions`);

  const config = await loadConfig();
  if (isSyncConfigured(config)) {
    try {
      const result = await step("Sync with GitHub", () => syncIfDue(config.github));
      if (result) {
        console.log(`  → pulled ${result.pulled}, pushed=${result.pushed}`);
      } else {
        console.log(`  → skipped (runs every ${config.github.syncIntervalMinutes}m)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`⚠ GitHub sync failed: ${message}`);
    }
  } else {
    console.log("• GitHub sync: not configured (skipped)");
  }

  // Pre-warm aggregation BEFORE opening the port so the dashboard's first
  // request never hits a cold aggregation (slow or fails).
  const data = await step("Aggregate data (pre-warm)", () => aggregateData({}));
  console.log(`  → ${data.sessions?.length ?? 0} sessions, ${data.machines?.length ?? 0} machines`);

  const actualPort = await step(`Start web server on :${options.port}`, () =>
    serve(options.port, { autoFallback: !options.explicitPort }),
  );
  const url = `http://localhost:${actualPort}`;
  console.log(`● Dashboard → ${url}`);
  console.log(`★ Startup complete in ${fmt(Date.now() - overall)}`);

  if (options.open) {
    openBrowser(url);
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
        await syncIfDue(config.github);
      }
    } catch {
      // Background refresh failures are intentionally silent.
    } finally {
      refreshRunning = false;
    }
  }, config.refresh.intervalMinutes * 60 * 1000);
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
