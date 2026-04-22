import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, isSyncConfigured } from "../../src/core/config.js";

describe("sync configuration", () => {
  it("defaults refresh and sync intervals", () => {
    expect(DEFAULT_CONFIG.refresh.intervalMinutes).toBe(5);
    expect(DEFAULT_CONFIG.github.syncIntervalMinutes).toBe(60);
  });

  it("defaults GitHub sync to disabled", () => {
    expect(DEFAULT_CONFIG.github.repo).toBe("");
  });

  it("detects whether sync is configured", () => {
    expect(isSyncConfigured({ ...DEFAULT_CONFIG, github: { ...DEFAULT_CONFIG.github, repo: "", branch: "main" } })).toBe(false);
    expect(isSyncConfigured({ ...DEFAULT_CONFIG, github: { ...DEFAULT_CONFIG.github, repo: "owner/repo", branch: "main" } })).toBe(true);
  });
});
