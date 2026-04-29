import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { ProjectSummary, Session } from "../../core/types.js";
import { getSessionUsageEvents } from "../../core/usage-events.js";
import { useTheme } from "../theme/ThemeProvider.js";

interface ProjectActivityTableProps {
  projects: ProjectSummary[];
  sessions: Session[];
  searchQuery: string;
  selectedProject: string | null;
  onSelect: (projectKey: string) => void;
  onSearchChange: (value: string) => void;
  formatCurrency: (value: number) => string;
  pageSize?: number;
}

const CELL_SIZE = 10;
const CELL_GAP = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const COL_PROJECT_WIDTH = 220;
const COL_COST_WIDTH = 110;
const COL_ACTIVE_WIDTH = 110;
const COL_PROJECT_LEFT = 0;
const COL_COST_LEFT = COL_PROJECT_WIDTH;
const COL_ACTIVE_LEFT = COL_PROJECT_WIDTH + COL_COST_WIDTH;

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function ProjectActivityTable({
  projects,
  sessions,
  searchQuery,
  selectedProject,
  onSelect,
  onSearchChange,
  formatCurrency,
  pageSize = 15,
}: ProjectActivityTableProps) {
  const { theme } = useTheme();
  const { colors } = theme;

  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(projects.length / pageSize));

  useEffect(() => {
    if (page >= pageCount) setPage(0);
  }, [page, pageCount]);

  useEffect(() => {
    setPage(0);
  }, [searchQuery]);

  const pageStart = page * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, projects.length);
  const visible = projects.slice(pageStart, pageEnd);

  const { dayList, totalWidth, monthTicks, rowsHeat, maxDayCost } = useMemo(() => {
    if (visible.length === 0) {
      return { dayList: [] as string[], totalWidth: 0, monthTicks: [] as { x: number; label: string }[], rowsHeat: new Map<string, Map<string, { cost: number; sessions: number }>>(), maxDayCost: 0 };
    }
    const visibleKeys = new Set(visible.map((p) => p.projectKey));
    const visibleSessions = sessions.filter((s) => visibleKeys.has(s.project));

    if (visibleSessions.length === 0) {
      return { dayList: [], totalWidth: 0, monthTicks: [], rowsHeat: new Map(), maxDayCost: 0 };
    }

    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const s of visibleSessions) {
      for (const event of getSessionUsageEvents(s)) {
        const t = new Date(event.at).getTime();
        if (!Number.isFinite(t)) continue;
        if (t < minMs) minMs = t;
        if (t > maxMs) maxMs = t;
      }
    }

    const dayList: string[] = [];
    const start = new Date(minMs);
    start.setHours(0, 0, 0, 0);
    const end = new Date(maxMs);
    end.setHours(0, 0, 0, 0);
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      dayList.push(dayKey(new Date(t)));
    }

    const rowsHeat = new Map<string, Map<string, { cost: number; sessions: number }>>();
    const seenSessions = new Map<string, Set<string>>();
    let maxDayCost = 0;
    for (const s of visibleSessions) {
      for (const event of getSessionUsageEvents(s)) {
        const date = new Date(event.at);
        if (Number.isNaN(date.getTime())) continue;
        const key = dayKey(date);
        let row = rowsHeat.get(s.project);
        if (!row) {
          row = new Map();
          rowsHeat.set(s.project, row);
        }
        const cell = row.get(key) ?? { cost: 0, sessions: 0 };
        cell.cost += event.cost?.total ?? 0;
        const seenKey = `${s.project}:${key}`;
        const seen = seenSessions.get(seenKey) ?? new Set<string>();
        if (!seen.has(s.id)) {
          cell.sessions += 1;
          seen.add(s.id);
          seenSessions.set(seenKey, seen);
        }
        row.set(key, cell);
        if (cell.cost > maxDayCost) maxDayCost = cell.cost;
      }
    }

    const totalWidth = dayList.length * (CELL_SIZE + CELL_GAP);

    const monthTicks: { x: number; label: string }[] = [];
    let lastMonth = "";
    dayList.forEach((d, i) => {
      const mk = d.slice(0, 7);
      if (mk !== lastMonth) {
        lastMonth = mk;
        const dt = parseDayKey(d);
        monthTicks.push({
          x: i * (CELL_SIZE + CELL_GAP),
          label: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`,
        });
      }
    });

    return { dayList, totalWidth, monthTicks, rowsHeat, maxDayCost };
  }, [visible, sessions]);

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
              : `Ranked by total cost · Showing ${pageStart + 1}–${pageEnd} of ${projects.length}${dayList.length ? ` · ${dayList.length} days` : ""}`}
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
          <table className="min-w-full text-sm" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
            <thead style={{ color: "var(--text-muted)" }}>
              <tr>
                <th
                  className="px-4 py-2 text-left font-medium"
                  style={{
                    position: "sticky",
                    left: COL_PROJECT_LEFT,
                    zIndex: 3,
                    background: "var(--bg-panel-muted)",
                    width: COL_PROJECT_WIDTH,
                    minWidth: COL_PROJECT_WIDTH,
                  }}
                >
                  Project
                </th>
                <th
                  className="px-4 py-2 text-right font-medium"
                  style={{
                    position: "sticky",
                    left: COL_COST_LEFT,
                    zIndex: 3,
                    background: "var(--bg-panel-muted)",
                    width: COL_COST_WIDTH,
                    minWidth: COL_COST_WIDTH,
                  }}
                >
                  Cost
                </th>
                <th
                  className="px-4 py-2 text-right font-medium"
                  style={{
                    position: "sticky",
                    left: COL_ACTIVE_LEFT,
                    zIndex: 3,
                    background: "var(--bg-panel-muted)",
                    width: COL_ACTIVE_WIDTH,
                    minWidth: COL_ACTIVE_WIDTH,
                    boxShadow: "2px 0 0 0 var(--border)",
                  }}
                >
                  Active Days
                </th>
                <th
                  className="px-3 py-2 text-left font-medium"
                  style={{ background: "var(--bg-panel-muted)" }}
                >
                  {totalWidth > 0 ? (
                    <svg width={Math.max(totalWidth, 1)} height={14} style={{ display: "block" }}>
                      {monthTicks.map((t, i) => (
                        <text key={i} x={t.x} y={11} fontSize={10} fill={colors.chartAxis} textAnchor="start">
                          {t.label}
                        </text>
                      ))}
                    </svg>
                  ) : (
                    "Activity"
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((project, idx) => {
                const isSelected = selectedProject === project.projectKey;
                const dim = selectedProject != null && !isSelected;
                const color = colors.chartPalette[idx % colors.chartPalette.length];
                const cells = rowsHeat.get(project.projectKey);
                const rowBg = isSelected ? "var(--badge-bg)" : "var(--bg-panel)";
                return (
                  <tr
                    key={project.projectKey}
                    data-testid="project-row"
                    className="cursor-pointer border-t transition"
                    style={{
                      borderColor: "var(--border)",
                    }}
                    onClick={() => onSelect(project.projectKey)}
                  >
                    <td
                      className="px-4 py-2 font-medium"
                      style={{
                        color: "var(--text-primary)",
                        position: "sticky",
                        left: COL_PROJECT_LEFT,
                        zIndex: 2,
                        background: rowBg,
                        width: COL_PROJECT_WIDTH,
                        minWidth: COL_PROJECT_WIDTH,
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          style={{
                            display: "inline-block",
                            width: 10,
                            height: 10,
                            flexShrink: 0,
                            borderRadius: 2,
                            background: color,
                            opacity: dim ? 0.35 : 1,
                          }}
                        />
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
                    <td
                      className="px-4 py-2 text-right"
                      style={{
                        color: "var(--text-primary)",
                        position: "sticky",
                        left: COL_COST_LEFT,
                        zIndex: 2,
                        background: rowBg,
                        width: COL_COST_WIDTH,
                        minWidth: COL_COST_WIDTH,
                      }}
                    >
                      {formatCurrency(project.totalCost)}
                    </td>
                    <td
                      className="px-4 py-2 text-right"
                      style={{
                        color: "var(--text-muted)",
                        position: "sticky",
                        left: COL_ACTIVE_LEFT,
                        zIndex: 2,
                        background: rowBg,
                        width: COL_ACTIVE_WIDTH,
                        minWidth: COL_ACTIVE_WIDTH,
                        boxShadow: "2px 0 0 0 var(--border)",
                      }}
                    >
                      {cells?.size ?? 0}
                    </td>
                    <td className="px-3 py-1" style={{ background: rowBg }}>
                      {totalWidth > 0 ? (
                        <svg width={Math.max(totalWidth, 1)} height={CELL_SIZE + 4} style={{ display: "block" }}>
                            {dayList.map((d, colIdx) => {
                              const x = colIdx * (CELL_SIZE + CELL_GAP);
                              const cell = cells?.get(d);
                              if (!cell) {
                                return (
                                  <rect
                                    key={colIdx}
                                    x={x}
                                    y={2}
                                    width={CELL_SIZE}
                                    height={CELL_SIZE}
                                    fill="var(--bg-panel-muted)"
                                    opacity={dim ? 0.3 : 1}
                                    rx={2}
                                  />
                                );
                              }
                              const ratio = maxDayCost > 0 ? cell.cost / maxDayCost : 0;
                              const alpha = Math.max(0.18, Math.sqrt(ratio));
                              return (
                                <rect
                                  key={colIdx}
                                  x={x}
                                  y={2}
                                  width={CELL_SIZE}
                                  height={CELL_SIZE}
                                  fill={withAlpha(color, dim ? alpha * 0.3 : alpha)}
                                  stroke={color}
                                  strokeOpacity={dim ? 0.2 : 0.5}
                                  strokeWidth={0.5}
                                  rx={2}
                                >
                                  <title>{`${project.projectLabel}\n${d} · ${formatCurrency(cell.cost)} · ${cell.sessions} session${cell.sessions === 1 ? "" : "s"}`}</title>
                                </rect>
                              );
                            })}
                          </svg>
                      ) : null}
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

function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
