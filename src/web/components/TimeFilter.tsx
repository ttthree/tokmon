interface TimeFilterProps {
  value: "all" | "7d" | "30d" | "12m";
  onChange: (value: TimeFilterProps["value"]) => void;
}

const OPTIONS: Array<TimeFilterProps["value"]> = ["all", "7d", "30d", "12m"];

export function TimeFilter({ value, onChange }: TimeFilterProps) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            value === option ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
