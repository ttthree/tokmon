import { useMemo } from "react";

import type { Session } from "../../core/types.js";
import { getSessionUsageEvents } from "../../core/usage-events.js";
import { useTheme } from "../theme/ThemeProvider.js";

interface ProjectTimelineProps {
  sessions: Session[];
  projects: { projectKey: string; projectLabel: string; totalCost: number }[];
  selectedProject: string | null;
  onSelectProject: (key: string | null) => void;
  formatCurrency: (n: number) => string;
  topN?: number;
}

const ROW_HEIGHT = 18;
const ROW_GAP = 4;
const CELL_SIZE = 14;
const CELL_GAP = 2;
const LABEL_WIDTH = 180;
const TICK_HEIGHT = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function ProjectTimeline({
  sessions,
  projects,
  selectedProject,
  onSelectProject,
  formatCurrency,
  topN = 10,
}: ProjectTimelineProps) {
  const { theme } = useTheme();
  const { colors } = theme;

  const { rows, dayList, totalWidth, maxDayCost, monthTicks } = useMemo(() => {
    const topProjects = projects.slice(0, topN);
    const projectKeys = new Set(topProjects.map((p) => p.projectKey));
    const visibleSessions = sessions.filter((s) => projectKeys.has(s.project));

    if (visibleSessions.length === 0) {
      return { rows: [], dayList: [] as string[], totalWidth: 0, maxDayCost: 0, monthTicks: [] as { x: number; label: string }[] };
    }

    // Find min/max day across all visible sessions
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

    // Build continuous day list (so gaps are visible)
    const dayList: string[] = [];
    const start = new Date(minMs);
    start.setHours(0, 0, 0, 0);
    const end = new Date(maxMs);
    end.setHours(0, 0, 0, 0);
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      dayList.push(dayKey(new Date(t)));
    }
    const dayIndex = new Map<string, number>();
    dayList.forEach((d, i) => dayIndex.set(d, i));

    // Aggregate per-project per-day
    type DayCell = { cost: number; sessions: number; tokens: number };
    const perRow = new Map<string, Map<string, DayCell>>();
    const seenSessions = new Map<string, Set<string>>();
    let maxDayCost = 0;
    for (const s of visibleSessions) {
      for (const event of getSessionUsageEvents(s)) {
        const d = new Date(event.at);
        if (Number.isNaN(d.getTime())) continue;
        const key = dayKey(d);
        let row = perRow.get(s.project);
        if (!row) {
          row = new Map();
          perRow.set(s.project, row);
        }
        const cell = row.get(key) ?? { cost: 0, sessions: 0, tokens: 0 };
        cell.cost += event.cost?.total ?? 0;
        cell.tokens += event.tokens.input + event.tokens.output + event.tokens.cacheCreation + event.tokens.cacheRead;
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

    const rows = topProjects.map((p, idx) => ({
      project: p,
      color: colors.chartPalette[idx % colors.chartPalette.length],
      cells: perRow.get(p.projectKey) ?? new Map<string, DayCell>(),
    }));

    const totalWidth = dayList.length * (CELL_SIZE + CELL_GAP);

    // Month ticks for x-axis labels
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

    return { rows, dayList, totalWidth, maxDayCost, monthTicks };
  }, [sessions, projects, topN, colors.chartPalette]);

  if (rows.length === 0) {
    return (
      <div
        data-testid="project-timeline"
        className="rounded-2xl border p-4 text-sm"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-card)",
          color: "var(--text-muted)",
        }}
      >
        No sessions in this range.
      </div>
    );
  }

  const gridHeight = rows.length * (ROW_HEIGHT + ROW_GAP);

  return (
    <div
      data-testid="project-timeline"
      className="rounded-2xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
          Project Timeline
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {dayList[0]} → {dayList[dayList.length - 1]} · {dayList.length} days · Top {rows.length} projects
        </div>
      </div>
      <div style={{ display: "flex" }}>
        {/* Fixed label column */}
        <div style={{ width: LABEL_WIDTH, flexShrink: 0 }}>
          <div style={{ height: TICK_HEIGHT }} />
          {rows.map(({ project, color, cells }) => {
            const active = selectedProject === project.projectKey;
            const activeDays = cells.size;
            return (
              <button
                key={project.projectKey}
                onClick={() =>
                  onSelectProject(active ? null : project.projectKey)
                }
                className="flex w-full items-center gap-2 text-left text-xs"
                style={{
                  height: ROW_HEIGHT,
                  marginBottom: ROW_GAP,
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                  fontWeight: active ? 600 : 400,
                  paddingRight: 8,
                }}
                title={`${project.projectLabel} · active ${activeDays} day${activeDays === 1 ? "" : "s"}`}
              >
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    flexShrink: 0,
                    borderRadius: 2,
                    background: color,
                    opacity: active || !selectedProject ? 1 : 0.35,
                  }}
                />
                <span className="truncate flex-1">{project.projectLabel}</span>
                <span className="shrink-0 tabular-nums" style={{ color: "var(--text-muted)" }}>
                  {activeDays}d
                </span>
              </button>
            );
          })}
        </div>
        {/* Scrollable grid */}
        <div style={{ flex: 1, overflowX: "auto" }}>
          <svg width={Math.max(totalWidth, 1)} height={TICK_HEIGHT + gridHeight} style={{ display: "block" }}>
            {/* Month tick labels + separators */}
            {monthTicks.map((t, i) => (
              <g key={i}>
                <line
                  x1={t.x - CELL_GAP / 2}
                  x2={t.x - CELL_GAP / 2}
                  y1={TICK_HEIGHT - 2}
                  y2={TICK_HEIGHT + gridHeight}
                  stroke={colors.chartGrid}
                  strokeWidth={1}
                />
                <text
                  x={t.x}
                  y={TICK_HEIGHT - 10}
                  fontSize={11}
                  fill={colors.chartAxis}
                  textAnchor="start"
                >
                  {t.label}
                </text>
              </g>
            ))}
            {/* Rows */}
            {rows.map((row, rowIdx) => {
              const y = TICK_HEIGHT + rowIdx * (ROW_HEIGHT + ROW_GAP);
              const active = selectedProject === row.project.projectKey;
              const dim = selectedProject != null && !active;
              return (
                <g key={row.project.projectKey}>
                  {dayList.map((d, colIdx) => {
                    const x = colIdx * (CELL_SIZE + CELL_GAP);
                    const cell = row.cells.get(d);
                    if (!cell) {
                      return (
                        <rect
                          key={colIdx}
                          x={x}
                          y={y + (ROW_HEIGHT - CELL_SIZE) / 2}
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
                        y={y + (ROW_HEIGHT - CELL_SIZE) / 2}
                        width={CELL_SIZE}
                        height={CELL_SIZE}
                        fill={withAlpha(row.color, dim ? alpha * 0.3 : alpha)}
                        stroke={row.color}
                        strokeOpacity={dim ? 0.2 : 0.5}
                        strokeWidth={0.5}
                        rx={2}
                      >
                        <title>
                          {`${row.project.projectLabel}\n${d} · ${formatCurrency(cell.cost)} · ${cell.sessions} session${cell.sessions === 1 ? "" : "s"}`}
                        </title>
                      </rect>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}

function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
