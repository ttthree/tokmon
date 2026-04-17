import { useState } from "react";
import { Area, Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatCompact } from "../format.js";
import { useTheme } from "../theme/ThemeProvider.js";

interface TokenChartPoint {
  label: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
}

type ChartMode = "both" | "tokens" | "cost";

export function TokenChart({ data, title = "Token & Cost Trend" }: { data: TokenChartPoint[]; title?: string }) {
  const { theme } = useTheme();
  const { colors } = theme;
  const [mode, setMode] = useState<ChartMode>("both");
  const showTokens = mode !== "cost";
  const showCost = mode !== "tokens";
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
          <ComposedChart data={data}>
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
                if (name === "Cost") return [`$${value.toFixed(2)}`, "Cost"];
                return [formatCompact(value), name];
              }}
              contentStyle={{
                borderRadius: "8px",
                border: `1px solid ${colors.chartGrid}`,
                background: theme.cssVars["--bg-panel"],
                color: theme.cssVars["--text-primary"],
              }}
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
            {showCost ? (
              <Bar yAxisId="cost" dataKey="cost" name="Cost" fill={colors.tokenCost} radius={[4, 4, 0, 0]} />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
