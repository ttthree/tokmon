import { describe, expect, it } from "vitest";

import { SOURCE_DEFAULT_PRICING, calculateCost, lookupPricing, normalizeModelName } from "../../src/core/pricing.js";

describe("pricing", () => {
  it("calculates cost from token usage", () => {
    const cost = calculateCost(
      { input: 1000, output: 500, cacheCreation: 200, cacheRead: 10000 },
      { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    );
    expect(cost.total).toBeCloseTo(0.01325);
  });

  it("normalizes date-suffixed models", () => {
    expect(normalizeModelName("claude-sonnet-4-20250514")).toContain("claude-sonnet-4");
  });

  it("falls back to source defaults", () => {
    expect(lookupPricing({}, "unknown-model", "claude-code")).toEqual(SOURCE_DEFAULT_PRICING["claude-code"]);
  });
});
