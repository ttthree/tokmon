interface StatCardProps {
  label: string;
  value: string;
  testId?: string;
}

export function StatCard({ label, value, testId }: StatCardProps) {
  return (
    <div data-testid="stat-card" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div data-testid={testId} className="text-2xl font-semibold tracking-tight text-slate-900">{value}</div>
      <div className="label mt-1 text-sm text-slate-500">{label}</div>
    </div>
  );
}
