import { useId } from "react";
import { Bar, BarChart, Cell, Customized, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useTheme } from "../theme/ThemeProvider.js";

interface BreakdownItem {
  name: string;
  value: number;
  tokens?: number;
}

interface BreakdownChartProps {
  title: string;
  data: BreakdownItem[];
  dataKey?: "value" | "tokens";
  formatValue?: (value: number) => string;
  testId?: string;
  selectedName?: string | null;
  onSelect?: (name: string | null) => void;
}

function makeRightAlignedLabels(insideColor: string, outsideColor: string, idPrefix: string) {
  return function RightAlignedLabels(props: any) {
    const { xAxisMap, formattedGraphicalItems } = props;
    if (!xAxisMap || !formattedGraphicalItems?.length) return null;
    const xAxis: any = Object.values(xAxisMap)[0];
    const rightEdge = xAxis.x + xAxis.width;
    const padding = 8;
    const points: any[] = formattedGraphicalItems[0]?.props?.data ?? [];
    return (
      <g pointerEvents="none">
        <defs>
          {points.map((p: any, i: number) => {
            const barLeft = p.x ?? 0;
            const barRight = barLeft + (p.width ?? 0);
            return (
              <g key={i}>
                <clipPath id={`${idPrefix}-inside-${i}`}>
                  <rect x={barLeft} y={p.y} width={Math.max(0, barRight - barLeft)} height={p.height ?? 0} />
                </clipPath>
                <clipPath id={`${idPrefix}-outside-${i}`}>
                  <rect x={barRight} y={p.y} width={Math.max(0, rightEdge - barRight)} height={p.height ?? 0} />
                </clipPath>
              </g>
            );
          })}
        </defs>
        {points.map((p: any, i: number) => {
          const labelX = rightEdge - padding;
          const labelY = p.y + (p.height ?? 0) / 2;
          const name = p.payload?.name ?? "";
          const baseProps = {
            x: labelX,
            y: labelY,
            textAnchor: "end" as const,
            dominantBaseline: "central" as const,
            fontSize: 12,
            fontWeight: 500,
          };
          return (
            <g key={i}>
              <text {...baseProps} fill={outsideColor} clipPath={`url(#${idPrefix}-outside-${i})`}>
                {name}
              </text>
              <text {...baseProps} fill={insideColor} clipPath={`url(#${idPrefix}-inside-${i})`}>
                {name}
              </text>
            </g>
          );
        })}
      </g>
    );
  };
}

export function BreakdownChart({
  title,
  data,
  dataKey = "value",
  formatValue,
  testId,
  selectedName,
  onSelect,
}: BreakdownChartProps) {
  const { theme } = useTheme();
  const { colors } = theme;
  const formatter = formatValue ?? ((v: number) => `$${v.toFixed(2)}`);
  const clickable = Boolean(onSelect);

  const handleBarClick = (payload: any) => {
    if (!onSelect) return;
    const name: string | undefined = payload?.name ?? payload?.payload?.name;
    if (!name) return;
    onSelect(name === selectedName ? null : name);
  };

  const insideLabelColor = theme.cssVars["--accent-fg"] ?? "#ffffff";
  const outsideLabelColor = theme.cssVars["--text-secondary"] ?? "#334155";
  const rawId = useId();
  const idPrefix = `bar-label-${rawId.replace(/:/g, "")}`;
  const LabelLayer = makeRightAlignedLabels(insideLabelColor, outsideLabelColor, idPrefix);

  return (
    <div
      data-testid={testId}
      className="rounded-2xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
          {title}
        </div>
        {selectedName && onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-xs font-medium"
            style={{ color: "var(--text-muted)" }}
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 4, right: 20, top: 5, bottom: 5 }}>
            <XAxis type="number" stroke={colors.chartAxis} tickFormatter={formatter} fontSize={12} />
            <YAxis type="category" dataKey="name" hide />
            <Tooltip
              formatter={(v: number) => formatter(v)}
              contentStyle={{
                borderRadius: "8px",
                border: `1px solid ${colors.chartGrid}`,
                background: theme.cssVars["--bg-panel"],
                color: theme.cssVars["--text-primary"],
              }}
            />
            <Bar
              dataKey={dataKey}
              radius={[0, 4, 4, 0]}
              onClick={clickable ? handleBarClick : undefined}
              style={clickable ? { cursor: "pointer" } : undefined}
            >
              {data.map((item, index) => {
                const baseColor = colors.chartPalette[index % colors.chartPalette.length];
                const isSelected = selectedName != null && item.name === selectedName;
                const isDimmed = selectedName != null && !isSelected;
                return <Cell key={index} fill={isDimmed ? colors.chartDim : baseColor} />;
              })}
            </Bar>
            <Customized component={LabelLayer} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
