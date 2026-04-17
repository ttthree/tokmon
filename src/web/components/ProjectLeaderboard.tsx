import type { ProjectSummary } from "../../core/types.js";

interface ProjectLeaderboardProps {
  projects: ProjectSummary[];
  searchQuery: string;
  selectedProject: string | null;
  onSelect: (projectKey: string) => void;
  onSearchChange: (value: string) => void;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number) => string;
}

export function ProjectLeaderboard({
  projects,
  searchQuery,
  selectedProject,
  onSelect,
  onSearchChange,
  formatCurrency,
  formatPercent,
}: ProjectLeaderboardProps) {
  return (
    <section data-testid="project-leaderboard" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-700">Project Leaderboard</div>
          <div className="text-xs text-slate-500">Ranked by total cost for the active range.</div>
        </div>
        <input
          data-testid="leaderboard-search-input"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search projects"
          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none ring-0 placeholder:text-slate-400 sm:max-w-xs"
        />
      </div>

      {projects.length === 0 ? (
        <div data-testid="leaderboard-empty-state" className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-sm text-slate-500">
          {searchQuery.trim() ? "No projects match this search." : "No projects found for this time range."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Project</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 text-right font-medium">Sessions</th>
                <th className="px-4 py-2 text-right font-medium">Avg / Session</th>
                <th className="px-4 py-2 text-right font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const isSelected = selectedProject === project.projectKey;
                return (
                  <tr
                    key={project.projectKey}
                    data-testid="project-row"
                    className={`cursor-pointer border-t border-slate-100 transition ${isSelected ? "bg-sky-50" : "hover:bg-slate-50"}`}
                    onClick={() => onSelect(project.projectKey)}
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <div className="flex items-center gap-2">
                        <span>{project.projectLabel}</span>
                        {isSelected ? <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-sky-700">Selected</span> : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-900">{formatCurrency(project.totalCost)}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{project.sessionCount}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{formatCurrency(project.avgCostPerSession)}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{formatTrend(project.trend, formatCurrency, formatPercent)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatTrend(
  trend: ProjectSummary["trend"],
  formatCurrency: (value: number) => string,
  formatPercent: (value: number) => string,
): string {
  if (!trend) return "Unavailable";
  if (trend.deltaPct === undefined) return `${formatCurrency(trend.delta)} vs prev`;
  return formatPercent(trend.deltaPct);
}
