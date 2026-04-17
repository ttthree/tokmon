import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, isSyncConfigured } from "../../src/core/config.js";

describe("sync configuration", () => {
  it("defaults GitHub sync to disabled", () => {
    expect(DEFAULT_CONFIG.github.repo).toBe("");
  });

  it("detects whether sync is configured", () => {
    expect(isSyncConfigured({ ...DEFAULT_CONFIG, github: { repo: "", branch: "main" } })).toBe(false);
    expect(isSyncConfigured({ ...DEFAULT_CONFIG, github: { repo: "owner/repo", branch: "main" } })).toBe(true);
  });
});
