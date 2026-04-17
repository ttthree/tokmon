import type { ProjectSummary } from "../../core/types.js";
import { formatCompact } from "../format.js";

interface ProjectDetailCardProps {
  project: ProjectSummary | null;
  onClear: () => void;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number) => string;
}

export function ProjectDetailCard({ project, onClear, formatCurrency, formatPercent }: ProjectDetailCardProps) {
  return (
    <section data-testid="project-detail" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-700">Selected Project</div>
          <div className="text-xs text-slate-500">Inspect the project summary and cost drivers.</div>
        </div>
        {project ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
          >
            Clear
          </button>
        ) : null}
      </div>

      {!project ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-sm text-slate-500">
          Select a project to inspect cost drivers.
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-900">{project.projectLabel}</h2>
              <div className="mt-2 text-sm text-slate-500">{formatTrend(project, formatCurrency, formatPercent)}</div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Metric label="Total Cost" value={formatCurrency(project.totalCost)} />
            <Metric label="Total Sessions" value={String(project.sessionCount)} />
            <Metric label="Total Tokens" value={formatCompact(project.totalTokens)} />
            <Metric label="Avg Cost / Session" value={formatCurrency(project.avgCostPerSession)} />
            <Metric label="Avg Turns / Session" value={project.avgTurnsPerSession.toFixed(1)} />
            <Metric label="Active Days" value={String(project.activeDays)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Top Source" value={project.topSource ?? "—"} />
            <Metric label="Top Model" value={project.topModel ?? "—"} />
            <Metric label="Top Machine" value={project.topMachine ?? "—"} />
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Token Mix</div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Input" value={formatCompact(project.tokenBreakdown.input)} />
              <Metric label="Output" value={formatCompact(project.tokenBreakdown.output)} />
              <Metric label="Cache Write" value={formatCompact(project.tokenBreakdown.cacheCreation)} />
              <Metric label="Cache Read" value={formatCompact(project.tokenBreakdown.cacheRead)} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-2 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function formatTrend(project: ProjectSummary, formatCurrency: (value: number) => string, formatPercent: (value: number) => string): string {
  if (!project.trend) return "Trend unavailable for this range.";
  if (project.trend.deltaPct === undefined) {
    return `${formatCurrency(project.trend.delta)} vs previous period`;
  }
  return `${formatPercent(project.trend.deltaPct)} vs previous period`;
}
