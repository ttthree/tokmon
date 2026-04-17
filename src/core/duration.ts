const DEFAULT_IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Compute "active" duration from a list of event timestamps (ms since epoch).
 *
 * Wall-clock span (last - first) is misleading because many sessions stay open
 * idle for hours or days. Instead we treat each event as contributing up to
 * `idleThresholdMs` of activity before it: sum of min(gap, idleThresholdMs)
 * over consecutive event pairs. Long gaps are capped at the threshold.
 *
 * - Zero or one event: returns 0.
 * - All gaps < threshold: equivalent to wall-clock span.
 * - Any gap >= threshold: contributes only the threshold to active time.
 */
export function computeActiveDurationSeconds(
  timestampsMs: Array<number | undefined | null>,
  idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): number {
  const clean: number[] = [];
  for (const t of timestampsMs) {
    if (typeof t === "number" && Number.isFinite(t)) clean.push(t);
  }
  if (clean.length < 2) return 0;
  clean.sort((a, b) => a - b);
  let totalMs = 0;
  for (let i = 1; i < clean.length; i++) {
    const gap = clean[i] - clean[i - 1];
    if (gap <= 0) continue;
    totalMs += Math.min(gap, idleThresholdMs);
  }
  return Math.max(0, Math.round(totalMs / 1000));
}
