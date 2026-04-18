import { useMemo, useState, useEffect } from "react";

import type { Session } from "../../core/types.js";

interface SessionTableProps {
  sessions: Session[];
  onSelect?: (session: Session, trigger: HTMLElement) => void;
  pageSize?: number;
  /**
   * Machine id of the machine currently serving the dashboard. Rows whose
   * session was collected elsewhere are rendered as non-interactive — the
   * underlying log files aren't reachable from here, so opening the detail
   * modal would only return an empty/error state.
   */
  localMachineId?: string | null;
  /** machineId → friendly name; falls back to the raw id if absent. */
  machineNames?: Map<string, string>;
}

type SortKey = "date" | "cost" | "duration";
type SortDirection = "asc" | "desc";

export function SessionTable({ sessions, onSelect, pageSize = 25, localMachineId, machineNames }: SessionTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const list = [...sessions];
    const mult = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let diff = 0;
      if (sortKey === "date") diff = a.createdAt.localeCompare(b.createdAt);
      else if (sortKey === "cost") diff = a.cost.total - b.cost.total;
      else if (sortKey === "duration") diff = a.durationSeconds - b.durationSeconds;
      return diff * mult;
    });
    return list;
  }, [sessions, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));

  // Reset to first page when the list shrinks below current page
  useEffect(() => {
    if (page >= pageCount) setPage(0);
  }, [page, pageCount]);

  const pageStart = page * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, sorted.length);
  const visible = sorted.slice(pageStart, pageEnd);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "date" ? "desc" : "desc");
    }
    setPage(0);
  }

  return (
    <div
      data-testid="session-table"
      className="rounded-2xl border"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-3 text-sm"
        style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
      >
        <span className="font-semibold">Recent Sessions</span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {sorted.length === 0
            ? "0 sessions"
            : `Showing ${pageStart + 1}–${pageEnd} of ${sorted.length}`}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead style={{ background: "var(--bg-panel-muted)", color: "var(--text-muted)" }}>
            <tr>
              <SortableTh label="Date" active={sortKey === "date"} dir={sortDir} onClick={() => toggleSort("date")} align="left" />
              <th className="px-4 py-2 text-left font-medium">Machine</th>
              <th className="px-4 py-2 text-left font-medium">Project</th>
              <th className="px-4 py-2 text-left font-medium">Engine</th>
              <th className="px-4 py-2 text-left font-medium">Model(s)</th>
              <th className="px-4 py-2 text-left font-medium">Prompt</th>
              <SortableTh label="Cost" active={sortKey === "cost"} dir={sortDir} onClick={() => toggleSort("cost")} align="right" />
              <SortableTh label="Duration" active={sortKey === "duration"} dir={sortDir} onClick={() => toggleSort("duration")} align="right" />
            </tr>
          </thead>
          <tbody>
            {visible.map((session) => {
              const isRemote = localMachineId !== undefined && localMachineId !== null && session.machineId !== localMachineId;
              return (
                <tr
                  key={`${session.machineId}:${session.source}:${session.id}`}
                  data-testid="session-row"
                  data-remote={isRemote ? "true" : undefined}
                  role={isRemote ? undefined : "button"}
                  tabIndex={isRemote ? -1 : 0}
                  aria-disabled={isRemote || undefined}
                  title={isRemote ? "Session collected on another machine — source files not available here" : undefined}
                  className="border-t transition focus:outline-none"
                  style={{
                    borderColor: "var(--border)",
                    cursor: isRemote ? "not-allowed" : "pointer",
                    opacity: isRemote ? 0.55 : 1,
                  }}
                  onClick={(event) => {
                    if (isRemote) return;
                    onSelect?.(session, event.currentTarget);
                  }}
                  onKeyDown={(event) => {
                    if (isRemote) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect?.(session, event.currentTarget);
                    }
                  }}
                >
                  <td className="px-4 py-3" style={{ color: "var(--text-muted)" }}>{session.createdAt.slice(0, 10)}</td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: "var(--text-muted)" }}>
                    {machineNames?.get(session.machineId) ?? session.machineId}
                    {isRemote ? (
                      <span
                        className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                        style={{ background: "var(--bg-panel-muted)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
                      >
                        remote
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-medium" style={{ color: "var(--text-primary)" }}>{session.project}</td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: "var(--text-muted)" }}>{session.engine ?? session.source}</td>
                  <td className="px-4 py-3" style={{ color: "var(--text-muted)" }}>{formatModels(session)}</td>
                  <td className="px-4 py-3" style={{ color: "var(--text-muted)" }}>{session.summary ?? session.firstPrompt ?? "(no summary)"}</td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--text-primary)" }}>${session.cost.total.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--text-muted)" }}>{Math.round(session.durationSeconds / 60)}m</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pageCount > 1 ? (
        <Pagination page={page} pageCount={pageCount} onChange={setPage} />
      ) : null}
    </div>
  );
}

function SortableTh({
  label,
  active,
  dir,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  dir: SortDirection;
  onClick: () => void;
  align: "left" | "right";
}) {
  const arrow = active ? (dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th className={`px-4 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide"
        style={{ color: active ? "var(--text-primary)" : "var(--text-muted)", background: "transparent" }}
      >
        {label}
        <span>{arrow}</span>
      </button>
    </th>
  );
}

function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  return (
    <div
      data-testid="session-pagination"
      className="flex items-center justify-between border-t px-4 py-3 text-xs"
      style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
    >
      <span>Page {page + 1} of {pageCount}</span>
      <div className="flex items-center gap-2">
        <PageButton disabled={page === 0} onClick={() => onChange(0)}>« First</PageButton>
        <PageButton disabled={page === 0} onClick={() => onChange(page - 1)}>‹ Prev</PageButton>
        <PageButton disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)}>Next ›</PageButton>
        <PageButton disabled={page >= pageCount - 1} onClick={() => onChange(pageCount - 1)}>Last »</PageButton>
      </div>
    </div>
  );
}

function PageButton({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
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

function formatModels(session: Session): string {
  const models = session.modelUsage ? Object.keys(session.modelUsage) : [];
  if (models.length === 0) return shortenModel(session.model || "-");
  if (models.length === 1) return shortenModel(models[0]);
  const primary = session.model && models.includes(session.model) ? session.model : models[0];
  const rest = models.filter((m) => m !== primary);
  return [primary, ...rest].map(shortenModel).join(", ");
}

function shortenModel(name: string): string {
  if (!name) return "-";
  return name
    .replace(/^anthropic\//i, "")
    .replace(/^openai\//i, "")
    .replace(/-2\d{7}$/, "");
}
