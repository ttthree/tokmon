import type { ReactNode } from "react";

type RangeFilter = "all" | "7d" | "30d" | "12m";

const RANGE_LABELS: Record<Exclude<RangeFilter, "all">, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "12m": "Last 12 months",
};

interface FilterChip {
  key: string;
  label: string;
  value: string;
  onClear: () => void;
}

interface ActiveFiltersBarProps {
  range: RangeFilter;
  onClearRange: () => void;
  sourceLabel: string | null;
  onClearSource: () => void;
  orchestratorLabel: string | null;
  onClearOrchestrator: () => void;
  machineLabel: string | null;
  onClearMachine: () => void;
  projectLabel: string | null;
  onClearProject: () => void;
  modelLabel: string | null;
  onClearModel: () => void;
  search: string;
  onClearSearch: () => void;
  projectSearch: string;
  onClearProjectSearch: () => void;
  onClearAll: () => void;
}

export function ActiveFiltersBar({
  range,
  onClearRange,
  sourceLabel,
  onClearSource,
  orchestratorLabel,
  onClearOrchestrator,
  machineLabel,
  onClearMachine,
  projectLabel,
  onClearProject,
  modelLabel,
  onClearModel,
  search,
  onClearSearch,
  projectSearch,
  onClearProjectSearch,
  onClearAll,
}: ActiveFiltersBarProps) {
  const chips: FilterChip[] = [];

  if (range !== "all") {
    chips.push({
      key: "range",
      label: "Time",
      value: RANGE_LABELS[range],
      onClear: onClearRange,
    });
  }
  if (sourceLabel) {
    chips.push({ key: "source", label: "Source", value: sourceLabel, onClear: onClearSource });
  }
  if (orchestratorLabel) {
    chips.push({ key: "orchestrator", label: "Orchestrator", value: orchestratorLabel, onClear: onClearOrchestrator });
  }
  if (machineLabel) {
    chips.push({ key: "machine", label: "Machine", value: machineLabel, onClear: onClearMachine });
  }
  if (projectLabel) {
    chips.push({ key: "project", label: "Project", value: projectLabel, onClear: onClearProject });
  }
  if (modelLabel) {
    chips.push({ key: "model", label: "Model", value: modelLabel, onClear: onClearModel });
  }
  if (search) {
    chips.push({ key: "search", label: "Search", value: `"${search}"`, onClear: onClearSearch });
  }
  if (projectSearch) {
    chips.push({
      key: "project-search",
      label: "Project search",
      value: `"${projectSearch}"`,
      onClear: onClearProjectSearch,
    });
  }

  if (chips.length === 0) return null;

  return (
    <div
      data-testid="active-filters-bar"
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4"
      style={{ bottom: 24 }}
    >
      <div
        className="pointer-events-auto flex max-w-full flex-wrap items-center gap-3 rounded-full border-2 px-4 py-2.5 text-sm"
        style={{
          background: "var(--accent)",
          borderColor: "var(--accent-fg)",
          color: "var(--accent-fg)",
          boxShadow:
            "0 0 0 6px color-mix(in srgb, var(--accent) 25%, transparent), 0 20px 40px -12px rgba(0, 0, 0, 0.45)",
          animation: "tokmon-filter-bar-pulse 2.4s ease-in-out infinite",
        }}
      >
        <style>
          {`@keyframes tokmon-filter-bar-pulse {
              0%, 100% {
                box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 25%, transparent), 0 20px 40px -12px rgba(0, 0, 0, 0.45);
              }
              50% {
                box-shadow: 0 0 0 10px color-mix(in srgb, var(--accent) 10%, transparent), 0 24px 48px -14px rgba(0, 0, 0, 0.55);
              }
            }`}
        </style>
        <span className="shrink-0 text-base" aria-hidden>
          ⚑
        </span>
        <span
          className="shrink-0 font-bold uppercase tracking-wider"
          style={{ color: "var(--accent-fg)", fontSize: 12 }}
        >
          Active filters · {chips.length}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Chip key={chip.key} label={chip.label} value={chip.value} onClear={chip.onClear} />
          ))}
        </div>
        {chips.length > 1 ? (
          <button
            onClick={onClearAll}
            className="ml-1 shrink-0 rounded-full px-3 py-1.5"
            style={{
              background: "var(--accent-fg)",
              color: "var(--accent)",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 0.3,
            }}
          >
            Clear all
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Chip({ label, value, onClear }: { label: string; value: ReactNode; onClear: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
      style={{
        background: "color-mix(in srgb, var(--accent-fg) 18%, transparent)",
        border: "1px solid color-mix(in srgb, var(--accent-fg) 35%, transparent)",
        color: "var(--accent-fg)",
      }}
    >
      <span style={{ opacity: 0.8, fontWeight: 500 }}>{label}:</span>
      <span style={{ fontWeight: 700 }}>{value}</span>
      <button
        onClick={onClear}
        aria-label={`Clear ${label} filter`}
        className="flex h-4 w-4 items-center justify-center rounded-full"
        style={{
          background: "transparent",
          color: "var(--accent-fg)",
          fontSize: 14,
          lineHeight: 1,
          opacity: 0.75,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "color-mix(in srgb, var(--accent-fg) 30%, transparent)";
          e.currentTarget.style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.opacity = "0.75";
        }}
      >
        ×
      </button>
    </span>
  );
}
