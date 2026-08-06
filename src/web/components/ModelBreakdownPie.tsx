import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { formatCompact } from "../format.js";
import { useTheme } from "../theme/ThemeProvider.js";

type Metric = "cost" | "tokens";

export interface ModelBreakdownPieItem {
  name: string;
  value: number;
  tokens: number;
}

export function ModelBreakdownPie({
  data,
  formatCurrency,
}: {
  data: ModelBreakdownPieItem[];
  formatCurrency: (value: number) => string;
}) {
  const { theme } = useTheme();
  const { colors } = theme;
  const [metric, setMetric] = useState<Metric>("cost");
  const dataKey = metric === "cost" ? "value" : "tokens";
  const total = useMemo(
    () => data.reduce((sum, item) => sum + item[dataKey], 0),
    [data, dataKey],
  );
  const formatValue = (value: number) => metric === "cost" ? formatCurrency(value) : formatCompact(value);

  return (
    <div
      data-testid="model-breakdown-pie"
      className="flex min-h-[286px] flex-col rounded-2xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
            Model Breakdown
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Share of {metric === "cost" ? "spend" : "token volume"}
          </div>
        </div>
        <div className="flex gap-1 text-xs">
          {(["cost", "tokens"] as Metric[]).map((option) => {
            const active = option === metric;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setMetric(option)}
                className="rounded px-2 py-1 capitalize"
                style={{
                  background: active ? "var(--accent)" : "var(--bg-panel-muted)",
                  color: active ? "var(--accent-fg)" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
      </div>

      {data.length > 0 && total > 0 ? (
        <div className="grid min-h-0 flex-1 grid-cols-[138px_minmax(0,1fr)] items-center gap-2">
          <div className="relative h-[154px] w-[138px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey={dataKey}
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={43}
                  outerRadius={65}
                  paddingAngle={2}
                  stroke="var(--bg-panel)"
                  strokeWidth={2}
                >
                  {data.map((item, index) => (
                    <Cell key={item.name} fill={colors.chartPalette[index % colors.chartPalette.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number, _name: string, item: { payload?: ModelBreakdownPieItem }) => [
                    `${formatValue(value)} · ${total > 0 ? ((value / total) * 100).toFixed(1) : "0.0"}%`,
                    item.payload?.name ?? "Model",
                  ]}
                  contentStyle={{
                    borderRadius: "8px",
                    border: `1px solid ${colors.chartGrid}`,
                    background: theme.cssVars["--bg-panel"],
                    color: theme.cssVars["--text-primary"],
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-muted)" }}>
                Total
              </span>
              <span className="max-w-[78px] truncate text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                {formatValue(total)}
              </span>
            </div>
          </div>

          <div className="min-w-0 space-y-2">
            {data.map((item, index) => {
              const itemValue = item[dataKey];
              return (
                <div key={item.name} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 text-[11px]">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: colors.chartPalette[index % colors.chartPalette.length] }}
                  />
                  <span className="truncate" title={item.name} style={{ color: "var(--text-secondary)" }}>
                    {item.name}
                  </span>
                  <span className="tabular-nums" style={{ color: "var(--text-muted)" }}>
                    {total > 0 ? `${Math.round((itemValue / total) * 100)}%` : "0%"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
          No model usage in this range
        </div>
      )}
    </div>
  );
}
