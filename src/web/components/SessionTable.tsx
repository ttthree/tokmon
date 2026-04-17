import type { Session } from "../../core/types.js";

interface SessionTableProps {
  sessions: Session[];
  onSelect?: (session: Session, trigger: HTMLElement) => void;
}

export function SessionTable({ sessions, onSelect }: SessionTableProps) {
  return (
    <div data-testid="session-table" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Recent Sessions</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-left font-medium">Project</th>
              <th className="px-4 py-2 text-left font-medium">Prompt</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
              <th className="px-4 py-2 text-right font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr
                key={`${session.machineId}:${session.source}:${session.id}`}
                data-testid="session-row"
                role="button"
                tabIndex={0}
                className="border-t border-slate-100 transition hover:bg-slate-50 focus:bg-sky-50 focus:outline-none"
                onClick={(event) => onSelect?.(session, event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect?.(session, event.currentTarget);
                  }
                }}
              >
                <td className="px-4 py-3 text-slate-600">{session.createdAt.slice(0, 10)}</td>
                <td className="px-4 py-3 font-medium text-slate-900">{session.project}</td>
                <td className="px-4 py-3 text-slate-600">{session.summary ?? session.firstPrompt ?? "(no summary)"}</td>
                <td className="px-4 py-3 text-right text-slate-900">${session.cost.total.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-slate-600">{Math.round(session.durationSeconds / 60)}m</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
