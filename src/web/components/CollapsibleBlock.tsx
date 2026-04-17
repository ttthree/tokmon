import { useId, useState } from "react";

interface CollapsibleBlockProps {
  title: string;
  tone?: "thinking" | "tool";
  defaultExpanded?: boolean;
  children: string;
  testId?: string;
}

export function CollapsibleBlock({ title, tone = "tool", defaultExpanded = false, children, testId }: CollapsibleBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();

  return (
    <div
      data-testid={testId}
      className={[
        "overflow-hidden rounded-2xl border shadow-sm",
        tone === "thinking" ? "border-amber-100 bg-amber-50/60" : "border-slate-200 bg-slate-50",
      ].join(" ")}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm font-medium text-slate-700"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{title}</span>
        <span className="text-xs text-slate-500">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded ? (
        <div id={panelId} className="border-t border-black/5 px-4 py-3">
          <pre className="whitespace-pre-wrap break-words text-xs font-mono text-slate-700">{children}</pre>
        </div>
      ) : null}
    </div>
  );
}
