import { useMemo, useState } from "react";

import type { Session } from "../../core/types.js";
import { formatCompact } from "../format.js";
import { useTheme } from "../theme/ThemeProvider.js";

type Metric = "cost" | "input" | "output" | "cacheRead";

const METRIC_LABELS: Record<Metric, string> = {
  cost: "Cost",
  input: "Input",
  output: "Output",
  cacheRead: "Cache Read",
};

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface BurnClockProps {
  sessions: Session[];
  formatCurrency: (n: number) => string;
}

export function BurnClock({ sessions, formatCurrency }: BurnClockProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  const [metric, setMetric] = useState<Metric>("cost");

  const { cells, max, peak, weekendPct, summaryCount, summaryValue } = useMemo(() => {
    // cells[dow][hour] -> { value, count }
    const cells: { value: number; count: number }[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ value: 0, count: 0 })),
    );
    let total = 0;
    let weekendTotal = 0;
    let sessionCount = 0;
    for (const s of sessions) {
      const d = new Date(s.createdAt);
      const dow = d.getDay();
      const h = d.getHours();
      let v = 0;
      switch (metric) {
        case "cost": v = s.cost.total; break;
        case "input": v = s.tokens.input; break;
        case "output": v = s.tokens.output; break;
        case "cacheRead": v = s.tokens.cacheRead; break;
      }
      cells[dow][h].value += v;
      cells[dow][h].count += 1;
      total += v;
      if (dow === 0 || dow === 6) weekendTotal += v;
      sessionCount += 1;
    }
    let max = 0;
    let peak = { dow: 0, hour: 0, value: 0 };
    for (let dow = 0; dow < 7; dow++) {
      for (let h = 0; h < 24; h++) {
        const v = cells[dow][h].value;
        if (v > max) max = v;
        if (v > peak.value) peak = { dow, hour: h, value: v };
      }
    }
    const weekendPct = total > 0 ? weekendTotal / total : 0;
    return { cells, max, peak, weekendPct, summaryCount: sessionCount, summaryValue: total };
  }, [sessions, metric]);

  const accent = colors.chartPalette[0] ?? "#2563eb";

  const formatValue = (v: number): string => {
    if (metric === "cost") return formatCurrency(v);
    return formatCompact(v);
  };

  return (
    <div
      data-testid="burn-clock"
      className="rounded-2xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
          Token Burn Clock
          <span className="ml-2 font-normal" style={{ color: "var(--text-muted)" }}>
            When do you burn {METRIC_LABELS[metric].toLowerCase()}?
          </span>
        </div>
        <div className="flex gap-1 text-xs">
          {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => {
            const active = m === metric;
            return (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className="rounded px-2 py-1"
                style={{
                  background: active ? "var(--accent)" : "var(--bg-panel-muted)",
                  color: active ? "var(--accent-fg)" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                {METRIC_LABELS[m]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-4">
        <div className="flex-1 overflow-x-auto">
          <table className="border-separate" style={{ borderSpacing: 2 }}>
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                {Array.from({ length: 24 }).map((_, h) => (
                  <th
                    key={h}
                    className="text-center text-[10px] font-normal"
                    style={{ color: "var(--text-muted)", minWidth: 18 }}
                  >
                    {h % 3 === 0 ? h : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 0].map((dow) => (
                <tr key={dow}>
                  <td
                    className="pr-2 text-right text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {DOW_LABELS[dow]}
                  </td>
                  {cells[dow].map((cell, h) => {
                    const ratio = max > 0 ? cell.value / max : 0;
                    // alpha curve — sqrt makes low values more visible
                    const alpha = cell.value === 0 ? 0 : Math.max(0.08, Math.sqrt(ratio));
                    const isPeak = dow === peak.dow && h === peak.hour && cell.value > 0;
                    return (
                      <td
                        key={h}
                        style={{
                          width: 18,
                          height: 18,
                          background: cell.value === 0 ? "var(--bg-panel-muted)" : withAlpha(accent, alpha),
                          border: isPeak
                            ? `1px solid ${colors.tokenCost}`
                            : "1px solid var(--border)",
                          borderRadius: 3,
                        }}
                        title={
                          cell.value === 0
                            ? `${DOW_LABELS[dow]} ${String(h).padStart(2, "0")}:00 · no activity`
                            : `${DOW_LABELS[dow]} ${String(h).padStart(2, "0")}:00 · ${formatValue(cell.value)} · ${cell.count} session${cell.count === 1 ? "" : "s"}`
                        }
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="w-40 shrink-0 space-y-3 text-xs">
          <SummaryRow
            label="Peak"
            value={
              peak.value > 0
                ? `${DOW_LABELS[peak.dow]} ${String(peak.hour).padStart(2, "0")}:00`
                : "—"
            }
            sub={peak.value > 0 ? formatValue(peak.value) : undefined}
          />
          <SummaryRow label="Weekend" value={`${Math.round(weekendPct * 100)}%`} sub="of total" />
          <SummaryRow
            label="Total"
            value={formatValue(summaryValue)}
            sub={`${summaryCount} sessions`}
          />
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ color: "var(--text-muted)" }}>{label}</div>
      <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{value}</div>
      {sub ? <div style={{ color: "var(--text-muted)" }}>{sub}</div> : null}
    </div>
  );
}

function withAlpha(hex: string, alpha: number): string {
  // Expect #rrggbb or #rgb
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h.split("").map((c) => c + c).join("");
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
