import type { ProjectSummary } from "../core/types.js";

export const MAX_VISIBLE_PROJECTS = 10;

export function getVisibleProjects(projects: ProjectSummary[], query: string): ProjectSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProjects = normalizedQuery
    ? projects.filter((project) => {
        const haystack = `${project.projectLabel} ${project.projectKey}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
    : projects;

  return filteredProjects.slice(0, MAX_VISIBLE_PROJECTS);
}
