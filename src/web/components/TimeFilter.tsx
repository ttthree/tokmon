interface TimeFilterProps {
  value: "all" | "7d" | "30d" | "12m";
  onChange: (value: TimeFilterProps["value"]) => void;
}

const OPTIONS: Array<TimeFilterProps["value"]> = ["all", "7d", "30d", "12m"];

export function TimeFilter({ value, onChange }: TimeFilterProps) {
  return (
    <div
      className="inline-flex rounded-lg border p-1"
      style={{ background: "var(--bg-panel)", borderColor: "var(--border)", boxShadow: "var(--shadow-card)" }}
    >
      {OPTIONS.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            className="rounded-md px-3 py-1.5 text-sm font-medium transition"
            style={{
              background: active ? "var(--accent)" : "transparent",
              color: active ? "var(--accent-fg)" : "var(--text-secondary)",
            }}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
