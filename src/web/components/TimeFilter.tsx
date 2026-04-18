interface TimeFilterProps {
  value: "all" | "7d" | "30d" | "12m";
  onChange: (value: TimeFilterProps["value"]) => void;
}

const OPTIONS: Array<TimeFilterProps["value"]> = ["all", "7d", "30d", "12m"];

export function TimeFilter({ value, onChange }: TimeFilterProps) {
  return (
    <div
      className="inline-flex h-8 rounded-md border p-0.5"
      style={{ background: "var(--bg-panel)", borderColor: "var(--border)" }}
    >
      {OPTIONS.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            className="rounded-[5px] px-2.5 text-xs font-medium leading-none transition flex items-center"
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
