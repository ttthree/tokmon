import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const COLORS = ["#0f766e", "#2563eb", "#7c3aed", "#ea580c", "#16a34a", "#64748b", "#dc2626", "#0891b2"];

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
}

export function BreakdownChart({ title, data, dataKey = "value", formatValue, testId }: BreakdownChartProps) {
  const formatter = formatValue ?? ((v: number) => `$${v.toFixed(2)}`);

  return (
    <div data-testid={testId} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">{title}</div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 0, right: 20, top: 5, bottom: 5 }}>
            <XAxis type="number" stroke="#64748b" tickFormatter={formatter} fontSize={12} />
            <YAxis type="category" dataKey="name" stroke="#64748b" width={100} fontSize={12} tick={{ fill: "#334155" }} />
            <Tooltip
              formatter={(v: number) => formatter(v)}
              contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0" }}
            />
            <Bar dataKey={dataKey} radius={[0, 4, 4, 0]}>
              {data.map((_, index) => (
                <Cell key={index} fill={COLORS[index % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
