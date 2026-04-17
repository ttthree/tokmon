import { Area, Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatCompact } from "../format.js";

interface TokenChartPoint {
  label: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
}

export function TokenChart({ data }: { data: TokenChartPoint[] }) {
  return (
    <div data-testid="token-chart" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">Token & Cost Trend</div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <XAxis dataKey="label" stroke="#64748b" fontSize={12} />
            <YAxis yAxisId="tokens" stroke="#64748b" tickFormatter={formatCompact} fontSize={12} />
            <YAxis yAxisId="cost" orientation="right" stroke="#0f766e" tickFormatter={(v) => `$${v.toFixed(0)}`} fontSize={12} />
            <Tooltip
              formatter={(value: number, name: string) => {
                if (name === "cost") return [`$${value.toFixed(2)}`, "Cost"];
                return [formatCompact(value), name];
              }}
              contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0" }}
            />
            <Area yAxisId="tokens" type="monotone" dataKey="cacheRead" name="Cache Read" stackId="1" fill="#bbf7d0" stroke="#86efac" />
            <Area yAxisId="tokens" type="monotone" dataKey="cacheCreation" name="Cache Write" stackId="1" fill="#bfdbfe" stroke="#60a5fa" />
            <Area yAxisId="tokens" type="monotone" dataKey="input" name="Input" stackId="1" fill="#c4b5fd" stroke="#8b5cf6" />
            <Area yAxisId="tokens" type="monotone" dataKey="output" name="Output" stackId="1" fill="#1e293b" stroke="#0f172a" />
            <Bar yAxisId="cost" dataKey="cost" name="Cost" fill="#334155" radius={[4, 4, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
