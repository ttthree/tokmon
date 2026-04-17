import type { ProjectSummary } from "../core/types.js";

export function getVisibleProjects(projects: ProjectSummary[], query: string): ProjectSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return projects;
  return projects.filter((project) => {
    const haystack = `${project.projectLabel} ${project.projectKey}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}
