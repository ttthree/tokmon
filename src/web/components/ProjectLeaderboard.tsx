import { useEffect, useState, type ReactNode } from "react";

import type { ProjectSummary } from "../../core/types.js";

interface ProjectLeaderboardProps {
  projects: ProjectSummary[];
  searchQuery: string;
  selectedProject: string | null;
  onSelect: (projectKey: string) => void;
  onSearchChange: (value: string) => void;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number) => string;
  pageSize?: number;
}

export function ProjectLeaderboard({
  projects,
  searchQuery,
  selectedProject,
  onSelect,
  onSearchChange,
  formatCurrency,
  formatPercent,
  pageSize = 15,
}: ProjectLeaderboardProps) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(projects.length / pageSize));

  useEffect(() => {
    if (page >= pageCount) setPage(0);
  }, [page, pageCount]);

  // Reset to page 0 when search query changes
  useEffect(() => {
    setPage(0);
  }, [searchQuery]);

  const pageStart = page * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, projects.length);
  const visible = projects.slice(pageStart, pageEnd);

  return (
    <section
      data-testid="project-leaderboard"
      className="rounded-2xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
            Project Leaderboard
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            {projects.length === 0
              ? "Ranked by total cost for the active range."
              : `Ranked by total cost · Showing ${pageStart + 1}–${pageEnd} of ${projects.length}`}
          </div>
        </div>
        <input
          data-testid="leaderboard-search-input"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search projects"
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none ring-0 sm:max-w-xs"
          style={{ background: "var(--bg-input)", borderColor: "var(--border)", color: "var(--text-primary)" }}
        />
      </div>

      {projects.length === 0 ? (
        <div
          data-testid="leaderboard-empty-state"
          className="rounded-xl border border-dashed px-4 py-8 text-sm"
          style={{ background: "var(--bg-panel-muted)", borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          {searchQuery.trim() ? "No projects match this search." : "No projects found for this time range."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead style={{ background: "var(--bg-panel-muted)", color: "var(--text-muted)" }}>
              <tr>
                <th className="px-4 py-2 text-left font-medium">Project</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 text-right font-medium">Sessions</th>
                <th className="px-4 py-2 text-right font-medium">Avg / Session</th>
                <th className="px-4 py-2 text-right font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((project) => {
                const isSelected = selectedProject === project.projectKey;
                return (
                  <tr
                    key={project.projectKey}
                    data-testid="project-row"
                    className="cursor-pointer border-t transition"
                    style={{
                      borderColor: "var(--border)",
                      background: isSelected ? "var(--badge-bg)" : "transparent",
                    }}
                    onClick={() => onSelect(project.projectKey)}
                  >
                    <td className="px-4 py-3 font-medium" style={{ color: "var(--text-primary)" }}>
                      <div className="flex items-center gap-2">
                        <span>{project.projectLabel}</span>
                        {isSelected ? (
                          <span
                            className="rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                          >
                            Selected
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--text-primary)" }}>
                      {formatCurrency(project.totalCost)}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--text-muted)" }}>
                      {project.sessionCount}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--text-muted)" }}>
                      {formatCurrency(project.avgCostPerSession)}
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--text-muted)" }}>
                      {formatTrend(project.trend, formatCurrency, formatPercent)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pageCount > 1 ? (
        <div
          data-testid="leaderboard-pagination"
          className="mt-3 flex items-center justify-between text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <span>Page {page + 1} of {pageCount}</span>
          <div className="flex items-center gap-2">
            <PageButton disabled={page === 0} onClick={() => setPage(0)}>« First</PageButton>
            <PageButton disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Prev</PageButton>
            <PageButton disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>Next ›</PageButton>
            <PageButton disabled={page >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>Last »</PageButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PageButton({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border px-2 py-1 transition"
      style={{
        borderColor: "var(--border)",
        color: disabled ? "var(--text-muted)" : "var(--text-primary)",
        background: disabled ? "transparent" : "var(--bg-panel-muted)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
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
