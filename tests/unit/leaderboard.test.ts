import { describe, expect, it } from "vitest";

import type { ProjectSummary } from "../../src/core/types.js";
import { getVisibleProjects } from "../../src/web/leaderboard.js";

describe("leaderboard filtering", () => {
  it("returns all projects when the query is empty and filters by label or key", () => {
    const projects = Array.from({ length: 12 }, (_, index) => createProject(`project-${index + 1}`, `Team ${index + 1}`));

    expect(getVisibleProjects(projects, "")).toHaveLength(12);
    expect(getVisibleProjects(projects, "team 12").map((project) => project.projectKey)).toEqual(["project-12"]);
    expect(getVisibleProjects(projects, "project-11").map((project) => project.projectKey)).toEqual(["project-11"]);
  });
});

function createProject(projectKey: string, projectLabel: string): ProjectSummary {
  return {
    projectKey,
    projectLabel,
    totalCost: 1,
    totalTokens: 1,
    sessionCount: 1,
    totalTurns: 1,
    avgCostPerSession: 1,
    avgTurnsPerSession: 1,
    activeDays: 1,
    tokenBreakdown: {
      input: 1,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    },
    costBreakdown: {
      input: 1,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      total: 1,
    },
    sourceBreakdown: [],
    modelBreakdown: [],
    machineBreakdown: [],
  };
}
