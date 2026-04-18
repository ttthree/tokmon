import { useState } from "react";
import { Area, Bar, ComposedChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatCompact } from "../format.js";
import { useTheme } from "../theme/ThemeProvider.js";

interface TokenChartPoint {
  label: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
  // Optional per-source cost breakdown for stacked bars
  costBySource?: Record<string, number>;
}

type ChartMode = "both" | "tokens" | "cost";

export function TokenChart({
  data,
  title = "Token & Cost Trend",
  sources,
  sourceLabels,
}: {
  data: TokenChartPoint[];
  title?: string;
  /** When provided & non-empty, renders one stacked Bar per source instead of a single Cost bar. */
  sources?: string[];
  /** Optional human-readable labels for sources (e.g. claude-code → "Claude Code"). */
  sourceLabels?: Record<string, string>;
}) {
  const { theme } = useTheme();
  const { colors } = theme;
  const [mode, setMode] = useState<ChartMode>("both");
  const showTokens = mode !== "cost";
  const showCost = mode !== "tokens";
  const stacked = Array.isArray(sources) && sources.length > 0;

  // Flatten costBySource into top-level keys so Recharts can read them as dataKeys.
  const chartData = stacked
    ? data.map((point) => {
        const { costBySource, ...rest } = point;
        const flat: Record<string, number | string> = { ...rest };
        for (const src of sources!) {
          flat[`cost__${src}`] = costBySource?.[src] ?? 0;
        }
        return flat;
      })
    : data;

  return (
    <div
      data-testid="token-chart"
      className="rounded-2xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
          {title}
        </div>
        <div className="flex gap-1 text-xs">
          {(["both", "tokens", "cost"] as ChartMode[]).map((m) => {
            const active = m === mode;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className="rounded px-2 py-1 capitalize"
                style={{
                  background: active ? "var(--accent)" : "var(--bg-panel-muted)",
                  color: active ? "var(--accent-fg)" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                {m === "both" ? "Both" : m === "tokens" ? "Tokens" : "Cost"}
              </button>
            );
          })}
        </div>
      </div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData}>
            <XAxis dataKey="label" stroke={colors.chartAxis} fontSize={12} />
            {showTokens ? (
              <YAxis yAxisId="tokens" stroke={colors.chartAxis} tickFormatter={formatCompact} fontSize={12} />
            ) : null}
            {showCost ? (
              <YAxis
                yAxisId="cost"
                orientation={showTokens ? "right" : "left"}
                stroke={colors.tokenCost}
                tickFormatter={(v) => `$${v.toFixed(0)}`}
                fontSize={12}
              />
            ) : null}
            <Tooltip
              formatter={(value: number, name: string) => {
                if (name === "Cost" || name.startsWith("Cost · ")) return [`$${value.toFixed(2)}`, name];
                return [formatCompact(value), name];
              }}
              contentStyle={{
                borderRadius: "8px",
                border: `1px solid ${colors.chartGrid}`,
                background: theme.cssVars["--bg-panel"],
                color: theme.cssVars["--text-primary"],
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: theme.cssVars["--text-secondary"] }}
              iconType="circle"
              iconSize={8}
            />
            {showTokens ? (
              <Area yAxisId="tokens" type="monotone" dataKey="cacheRead" name="Cache Read" stackId="1" fill={colors.tokenCacheRead} stroke={colors.tokenCacheRead} fillOpacity={0.5} />
            ) : null}
            {showTokens ? (
              <Area yAxisId="tokens" type="monotone" dataKey="cacheCreation" name="Cache Write" stackId="1" fill={colors.tokenCacheCreation} stroke={colors.tokenCacheCreation} fillOpacity={0.6} />
            ) : null}
            {showTokens ? (
              <Area yAxisId="tokens" type="monotone" dataKey="input" name="Input" stackId="1" fill={colors.tokenInput} stroke={colors.tokenInput} fillOpacity={0.7} />
            ) : null}
            {showTokens ? (
              <Area yAxisId="tokens" type="monotone" dataKey="output" name="Output" stackId="1" fill={colors.tokenOutput} stroke={colors.tokenOutput} fillOpacity={0.8} />
            ) : null}
            {showCost && stacked
              ? sources!.map((src, idx) => {
                  const palette = colors.chartPalette;
                  const fill = palette[idx % palette.length];
                  const isLast = idx === sources!.length - 1;
                  const label = sourceLabels?.[src] ?? src;
                  return (
                    <Bar
                      key={src}
                      yAxisId="cost"
                      dataKey={`cost__${src}`}
                      name={`Cost · ${label}`}
                      stackId="cost"
                      fill={fill}
                      radius={isLast ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                    />
                  );
                })
              : null}
            {showCost && !stacked ? (
              <Bar yAxisId="cost" dataKey="cost" name="Cost" fill={colors.tokenCost} radius={[4, 4, 0, 0]} />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
