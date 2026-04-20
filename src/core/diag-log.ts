import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getTokmonDirectory } from "./config.js";

/**
 * Append-only NDJSON diagnostic log. Used to record events that may explain
 * later anomalies (e.g. mars registry empty, attribution dropped on merge).
 *
 * Writes to ~/.tokmon/logs/diag.log. Best-effort: failures are swallowed so
 * logging never breaks the main pipeline.
 *
 * The log is rotated when it exceeds MAX_BYTES; the previous file is moved
 * aside as diag.log.1 (single rolling backup).
 */

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

let writeChain: Promise<void> = Promise.resolve();
let rotateChecked = false;

export interface DiagEvent {
  event: string;
  [key: string]: unknown;
}

export function getDiagLogDirectory(): string {
  return path.join(getTokmonDirectory(), "logs");
}

export function getDiagLogPath(): string {
  return path.join(getDiagLogDirectory(), "diag.log");
}

/**
 * Fire-and-forget log. Returns the chained promise so callers in tests can
 * await drainage, but production code can ignore the return value.
 */
export function logDiag(event: DiagEvent): Promise<void> {
  if (process.env.TOKMON_DISABLE_DIAG_LOG === "1" || process.env.NODE_ENV === "test" || process.env.VITEST) {
    return Promise.resolve();
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    ...event,
  }) + "\n";

  writeChain = writeChain.then(() => appendLine(line)).catch(() => {});
  return writeChain;
}

async function appendLine(line: string): Promise<void> {
  const dir = getDiagLogDirectory();
  const file = getDiagLogPath();
  try {
    await fsp.mkdir(dir, { recursive: true });
    if (!rotateChecked) {
      rotateChecked = true;
      await maybeRotate(file);
    }
    await fsp.appendFile(file, line, "utf8");
    // Cheap size check on each write to catch growth even within a long-running process.
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && stat.size > MAX_BYTES) {
      await maybeRotate(file);
    }
  } catch {
    // Swallow — diag log must never break the caller.
  }
}

async function maybeRotate(file: string): Promise<void> {
  try {
    const stat = await fsp.stat(file);
    if (stat.size <= MAX_BYTES) return;
    const backup = `${file}.1`;
    await fsp.rm(backup, { force: true });
    await fsp.rename(file, backup);
  } catch {
    // Either file doesn't exist (nothing to rotate) or rotate failed; either way, continue.
  }
}

/** For tests. */
export function _resetDiagLogState(): void {
  writeChain = Promise.resolve();
  rotateChecked = false;
}

/** Synchronous flush attempt for shutdown paths. */
export function flushDiagSync(): void {
  // Nothing buffered — appends are flushed by the OS as they happen.
  // Provided as an API hook in case we add buffering later.
  void fs;
}
