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
    <section
      data-testid="project-detail"
      className="rounded-2xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
            Selected Project
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            Inspect the project summary and cost drivers.
          </div>
        </div>
        {project ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border px-3 py-1.5 text-sm font-medium transition"
            style={{ borderColor: "var(--border)", color: "var(--text-secondary)", background: "var(--bg-panel-muted)" }}
          >
            Clear
          </button>
        ) : null}
      </div>

      {!project ? (
        <div
          className="rounded-xl border border-dashed px-4 py-6 text-sm"
          style={{ background: "var(--bg-panel-muted)", borderColor: "var(--border)", color: "var(--text-muted)" }}
        >
          Select a project to inspect cost drivers.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
              {project.projectLabel}
            </h2>
            <div className="text-sm" style={{ color: "var(--text-muted)" }}>
              {formatTrend(project, formatCurrency, formatPercent)}
            </div>
          </div>

          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Total Cost" value={formatCurrency(project.totalCost)} />
            <Metric label="Sessions" value={String(project.sessionCount)} />
            <Metric label="Tokens" value={formatCompact(project.totalTokens)} />
            <Metric label="Avg $ / Session" value={formatCurrency(project.avgCostPerSession)} />
            <Metric label="Avg Turns" value={project.avgTurnsPerSession.toFixed(1)} />
            <Metric label="Active Days" value={String(project.activeDays)} />
          </div>

          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-7">
            <Metric label="Top Source" value={project.topSource ?? "—"} />
            <Metric label="Top Model" value={project.topModel ?? "—"} />
            <Metric label="Top Machine" value={project.topMachine ?? "—"} />
            <Metric label="Input" value={formatCompact(project.tokenBreakdown.input)} />
            <Metric label="Output" value={formatCompact(project.tokenBreakdown.output)} />
            <Metric label="Cache Write" value={formatCompact(project.tokenBreakdown.cacheCreation)} />
            <Metric label="Cache Read" value={formatCompact(project.tokenBreakdown.cacheRead)} />
          </div>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-xl border px-3 py-3"
      style={{ background: "var(--bg-panel-muted)", borderColor: "var(--border)" }}
    >
      <div
        className="text-xs font-medium uppercase tracking-[0.18em]"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div className="mt-2 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
        {value}
      </div>
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
