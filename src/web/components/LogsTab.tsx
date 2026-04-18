import { useMemo, useState } from "react";

import type { TokenBreakdown } from "../../core/types.js";

const PAGE_SIZE = 20;

export interface LogDelta {
  sessions: number;
  turns: number;
  cost: number;
  tokens: TokenBreakdown;
}

export interface LogEntry {
  /** ISO timestamp when the change was observed. */
  at: string;
  /** Trigger for this snapshot diff: initial load, polling, or manual refresh. */
  trigger: "initial" | "poll" | "manual";
  delta: LogDelta;
}

interface LogsTabProps {
  entries: LogEntry[];
  formatCurrency: (value: number) => string;
  onClear: () => void;
}

const TRIGGER_LABEL: Record<LogEntry["trigger"], string> = {
  initial: "Initial load",
  poll: "Auto refresh",
  manual: "Manual refresh",
};

export function LogsTab({ entries, formatCurrency, onClear }: LogsTabProps) {
  // Newest first.
  const ordered = useMemo(() => [...entries].reverse(), [entries]);
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  // Clamp page if entries shrink (e.g. after clear).
  const safePage = Math.min(page, totalPages - 1);
  if (safePage !== page) setPage(safePage);

  const pageEntries = useMemo(
    () => ordered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [ordered, safePage],
  );

  return (
    <section
      className="rounded-2xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
            Change Log
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            {ordered.length === 0
              ? "Waiting for data updates\u2026 changes will appear here as the dashboard refreshes."
              : `${ordered.length} change${ordered.length === 1 ? "" : "s"} recorded \u2014 showing page ${safePage + 1} of ${totalPages}.`}
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={ordered.length === 0}
          className="self-start rounded-md border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            background: "var(--bg-panel)",
            borderColor: "var(--border)",
            color: "var(--text-primary)",
          }}
          data-testid="logs-clear"
        >
          Clear log
        </button>
      </div>

      {ordered.length === 0 ? (
        <div
          className="rounded-lg border border-dashed px-4 py-8 text-center text-xs"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          data-testid="logs-empty"
        >
          No changes recorded yet. Logs are recorded whenever the dashboard's totals change between refreshes.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" data-testid="logs-table">
              <thead>
                <tr style={{ color: "var(--text-muted)" }}>
                  <Th>Time</Th>
                  <Th>Trigger</Th>
                  <Th align="right">Sessions</Th>
                  <Th align="right">Turns</Th>
                  <Th align="right">Cost</Th>
                  <Th align="right">Input</Th>
                  <Th align="right">Output</Th>
                  <Th align="right">Cache write</Th>
                  <Th align="right">Cache read</Th>
                </tr>
              </thead>
              <tbody>
                {pageEntries.map((entry, index) => (
                  <tr
                    key={`${entry.at}-${safePage}-${index}`}
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <Td>{formatTime(entry.at)}</Td>
                    <Td>{TRIGGER_LABEL[entry.trigger]}</Td>
                    <DeltaCell value={entry.delta.sessions} format={formatInt} />
                    <DeltaCell value={entry.delta.turns} format={formatInt} />
                    <DeltaCell value={entry.delta.cost} format={formatCurrency} epsilon={0.0005} />
                    <DeltaCell value={entry.delta.tokens.input} format={formatInt} />
                    <DeltaCell value={entry.delta.tokens.output} format={formatInt} />
                    <DeltaCell value={entry.delta.tokens.cacheCreation} format={formatInt} />
                    <DeltaCell value={entry.delta.tokens.cacheRead} format={formatInt} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div
              className="mt-3 flex items-center justify-center gap-3"
              data-testid="logs-pagination"
            >
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="rounded-md border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  background: "var(--bg-panel)",
                  borderColor: "var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                &larr; Prev
              </button>
              <span className="text-xs tabular-nums" style={{ color: "var(--text-secondary)" }}>
                {safePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                className="rounded-md border px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  background: "var(--bg-panel)",
                  borderColor: "var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                Next &rarr;
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wider"
      style={{ textAlign: align }}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <td className="px-2 py-2 align-top" style={{ textAlign: align, color: "var(--text-primary)" }}>
      {children}
    </td>
  );
}

function DeltaCell({
  value,
  format,
  epsilon = 0.5,
}: {
  value: number;
  format: (v: number) => string;
  epsilon?: number;
}) {
  const isZero = Math.abs(value) < epsilon;
  const isPositive = value > 0;
  const color = isZero
    ? "var(--text-muted)"
    : isPositive
      ? "var(--positive, #16a34a)"
      : "var(--negative, #dc2626)";
  const sign = isZero ? "" : isPositive ? "+" : "\u2212";
  const display = isZero ? "\u2014" : `${sign}${format(Math.abs(value))}`;
  return (
    <td className="px-2 py-2 align-top tabular-nums" style={{ textAlign: "right", color }}>
      {display}
    </td>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
