import { describe, expect, it } from "vitest";

import { computeActiveDurationSeconds } from "../../src/core/duration.js";

describe("computeActiveDurationSeconds", () => {
  it("returns 0 for empty or single-event arrays", () => {
    expect(computeActiveDurationSeconds([])).toBe(0);
    expect(computeActiveDurationSeconds([123])).toBe(0);
    expect(computeActiveDurationSeconds([undefined, null])).toBe(0);
  });

  it("sums all gaps when every gap is below threshold", () => {
    const base = 1_700_000_000_000;
    // Three events at +0s, +60s, +120s → 120 active seconds
    const result = computeActiveDurationSeconds([base, base + 60_000, base + 120_000]);
    expect(result).toBe(120);
  });

  it("caps large gaps at the idle threshold", () => {
    const base = 1_700_000_000_000;
    // Two events 2 hours apart, default threshold is 10 minutes → active = 600s
    const result = computeActiveDurationSeconds([base, base + 2 * 60 * 60 * 1000]);
    expect(result).toBe(600);
  });

  it("mixes capped and uncapped gaps correctly", () => {
    const base = 1_700_000_000_000;
    const events = [
      base,
      base + 30_000, // +30s
      base + 90_000, // +60s
      base + 2 * 60 * 60 * 1000, // +2h (capped at 600s)
      base + 2 * 60 * 60 * 1000 + 45_000, // +45s
    ];
    // 30 + 60 + 600 + 45 = 735
    expect(computeActiveDurationSeconds(events)).toBe(735);
  });

  it("sorts out-of-order timestamps before summing", () => {
    const base = 1_700_000_000_000;
    const shuffled = [base + 120_000, base, base + 60_000];
    expect(computeActiveDurationSeconds(shuffled)).toBe(120);
  });

  it("respects custom idle threshold", () => {
    const base = 1_700_000_000_000;
    // Two events 2 minutes apart, threshold 1 minute → active = 60s
    const result = computeActiveDurationSeconds(
      [base, base + 2 * 60 * 1000],
      60 * 1000,
    );
    expect(result).toBe(60);
  });
});
