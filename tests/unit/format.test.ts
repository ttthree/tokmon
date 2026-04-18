import { describe, expect, it } from "vitest";

import { parseCost } from "../e2e/helpers/format.js";

describe("parseCost", () => {
  it("parses formatted currency", () => {
    expect(parseCost("$1,234.56")).toBeCloseTo(1234.56, 2);
  });

  it("returns NaN for null", () => {
    expect(Number.isNaN(parseCost(null))).toBe(true);
  });

  it("returns NaN for empty text", () => {
    expect(Number.isNaN(parseCost(""))).toBe(true);
  });
});
