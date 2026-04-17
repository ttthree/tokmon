import { describe, expect, it } from "vitest";

import { matchesPattern } from "../../src/core/project.js";

describe("project matching", () => {
  it("matches absolute paths", () => {
    expect(matchesPattern("/Users/example/work/repo", "/Users/example/work/repo")).toBe(true);
  });

  it("matches basename excludes", () => {
    expect(matchesPattern("/Users/example/work/.worktrees", ".worktrees")).toBe(true);
  });
});
