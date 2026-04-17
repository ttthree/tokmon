import { useEffect, useMemo, useRef, useState } from "react";

import type { CostBreakdown, DataResponse, ProjectSummary, Session, Source, TokenBreakdown } from "../core/types.js";
import { fetchDashboardData } from "./api.js";
import { BreakdownChart } from "./components/BreakdownChart.js";
import { ProjectDetailCard } from "./components/ProjectDetailCard.js";
import { ProjectLeaderboard } from "./components/ProjectLeaderboard.js";
import { SessionDetailModal } from "./components/SessionDetailModal.js";
import { SessionTable } from "./components/SessionTable.js";
import { StatCard } from "./components/StatCard.js";
import { TimeFilter } from "./components/TimeFilter.js";
import { TokenChart } from "./components/TokenChart.js";
import { formatCompact } from "./format.js";
import { getVisibleProjects } from "./leaderboard.js";

type RangeFilter = "all" | "7d" | "30d" | "12m";

const SOURCE_LABELS: Record<Source, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot CLI",
  eureka: "Eureka",
};

export function App() {
  const [range, setRange] = useState<RangeFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<Source | "all">("all");
  const [search, setSearch] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [data, setData] = useState<DataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedSessionTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (range === "7d") params.set("days", "7");
    if (range === "30d") params.set("days", "30");
    if (range === "12m") params.set("months", "12");

    fetchDashboardData(params)
      .then((response) => {
        setData(response);
        setError(null);
      })
      .catch((loadError: Error) => {
        setError(loadError.message);
      });
  }, [range]);

  useEffect(() => {
    if (!data || selectedProject === null) {
      return;
    }

    if (!data.projects.some((project) => project.projectKey === selectedProject)) {
      setSelectedProject(null);
    }
  }, [data, selectedProject]);

  // Clear selected project when source filter changes
  useEffect(() => {
    setSelectedProject(null);
  }, [sourceFilter]);

  // Derive available sources from data for the filter pills
  const availableSources = useMemo(() => {
    if (!data) return [];
    const sources = new Set(data.sessions.map((s) => s.source));
    return (["claude-code", "codex", "copilot-cli", "eureka"] as Source[]).filter((s) => sources.has(s));
  }, [data]);

  // Apply source filter to sessions before all other computations
  const sourceSessions = useMemo(() => {
    if (!data) return [];
    if (sourceFilter === "all") return data.sessions;
    return data.sessions.filter((s) => s.source === sourceFilter);
  }, [data, sourceFilter]);

  // Recompute totals for filtered sessions
  const filteredTotals = useMemo((): DataResponse["totals"] | undefined => {
    if (!data) return undefined;
    if (sourceFilter === "all") return data.totals;
    return computeFilteredTotals(sourceSessions);
  }, [data, sourceFilter, sourceSessions]);

  // Recompute projects for filtered sessions
  const sourceProjects = useMemo(() => {
    if (!data) return [];
    if (sourceFilter === "all") return data.projects;
    return buildFilteredProjects(sourceSessions);
  }, [data, sourceFilter, sourceSessions]);

  const visibleSessions = useMemo(() => {
    if (!selectedProject) return sourceSessions;
    return sourceSessions.filter((session) => session.project === selectedProject);
  }, [sourceSessions, selectedProject]);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return visibleSessions;
    return visibleSessions.filter((session) => {
      const haystack = [session.project, session.summary ?? "", session.firstPrompt ?? "", session.model].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [search, visibleSessions]);

  const visibleProjects = useMemo(() => getVisibleProjects(sourceProjects, projectSearch), [sourceProjects, projectSearch]);

  const chartData = useMemo(() => buildChartData(sourceSessions, range), [sourceSessions, range]);
  const projectData = useMemo(() => buildProjectData(sourceProjects), [sourceProjects]);
  const modelData = useMemo(() => buildModelData(sourceSessions), [sourceSessions]);
  const agentData = useMemo(() => buildAgentData(sourceSessions), [sourceSessions]);
  const tokenBreakdown = useMemo(() => buildTokenBreakdown(filteredTotals?.tokens), [filteredTotals]);
  const selectedProjectSummary = useMemo(
    () => sourceProjects.find((project) => project.projectKey === selectedProject) ?? null,
    [sourceProjects, selectedProject],
  );
  const selectedSourceData = useMemo(() => buildBreakdownChartData(selectedProjectSummary?.sourceBreakdown), [selectedProjectSummary]);
  const selectedModelData = useMemo(() => buildBreakdownChartData(selectedProjectSummary?.modelBreakdown), [selectedProjectSummary]);
  const selectedMachineData = useMemo(() => buildBreakdownChartData(selectedProjectSummary?.machineBreakdown), [selectedProjectSummary]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    const stillVisible = filteredSessions.some((session) => getSessionKey(session) === getSessionKey(selectedSession));
    if (!stillVisible) {
      setSelectedSession(null);
      selectedSessionTriggerRef.current?.focus();
    }
  }, [filteredSessions, selectedSession]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#e0f2fe,_#f8fafc_50%,_#f1f5f9)] px-4 py-8 text-slate-900 sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">TOKMON</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Token Monitor</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SourceFilter sources={availableSources} value={sourceFilter} onChange={setSourceFilter} />
            <TimeFilter value={range} onChange={setRange} />
          </div>
        </header>

        {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <StatCard testId="total-cost" label="Total Cost" value={formatCurrency(filteredTotals?.cost.total ?? 0)} />
          <StatCard label="Sessions" value={String(filteredTotals?.sessions ?? 0)} />
          <StatCard label="Turns" value={formatCompact(filteredTotals?.turns ?? 0)} />
          <StatCard label="Avg Duration" value={formatDuration(filteredTotals ? (filteredTotals.durationSeconds / Math.max(filteredTotals.sessions, 1)) : 0)} />
          <StatCard label="Cache Hit Rate" value={formatPercent(filteredTotals?.cacheHitRate ?? 0)} />
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <TokenChart data={chartData} />
          <div className="grid gap-4 grid-cols-2">
            {tokenBreakdown.map((item) => (
              <StatCard key={item.name} label={item.name} value={formatCompact(item.value)} />
            ))}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.15fr_1fr]">
          <ProjectLeaderboard
            projects={visibleProjects}
            searchQuery={projectSearch}
            selectedProject={selectedProject}
            onSelect={setSelectedProject}
            onSearchChange={setProjectSearch}
            formatCurrency={formatCurrency}
            formatPercent={formatPercent}
          />
          <ProjectDetailCard
            project={selectedProjectSummary}
            onClear={() => setSelectedProject(null)}
            formatCurrency={formatCurrency}
            formatPercent={formatPercent}
          />
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {selectedProjectSummary ? (
            <>
              <BreakdownChart testId="source-breakdown" title="Cost by Source" data={selectedSourceData} formatValue={(v) => `$${v.toFixed(2)}`} />
              <BreakdownChart testId="selected-model-breakdown" title="Cost by Model" data={selectedModelData} formatValue={(v) => `$${v.toFixed(2)}`} />
              <BreakdownChart testId="machine-breakdown" title="Cost by Machine" data={selectedMachineData} formatValue={(v) => `$${v.toFixed(2)}`} />
            </>
          ) : (
            <>
              <BreakdownChart
                testId="project-breakdown"
                title="Cost by Project"
                data={projectData}
                formatValue={(v) => `$${v.toFixed(2)}`}
              />
              <BreakdownChart
                testId="model-breakdown"
                title="Cost by Model"
                data={modelData}
                formatValue={(v) => `$${v.toFixed(2)}`}
              />
              <BreakdownChart
                testId="agent-breakdown"
                title="Cost by Agent"
                data={agentData}
                formatValue={(v) => `$${v.toFixed(2)}`}
              />
            </>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-700">Recent Sessions</div>
              <div className="text-xs text-slate-500">
                {selectedProjectSummary ? `Showing sessions for ${selectedProjectSummary.projectLabel}.` : "Showing sessions for all projects in range."}
              </div>
            </div>
            <input
              data-testid="search-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search project, prompt, or model"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none ring-0 placeholder:text-slate-400 sm:max-w-xs"
            />
          </div>
          <SessionTable
            sessions={filteredSessions.slice(0, 50)}
            onSelect={(session, trigger) => {
              selectedSessionTriggerRef.current = trigger;
              setSelectedSession(session);
            }}
          />
        </section>
      </div>
      {selectedSession ? <SessionDetailModal session={selectedSession} onClose={handleCloseSessionModal} formatCurrency={formatCurrency} /> : null}
    </main>
  );

  function handleCloseSessionModal() {
    setSelectedSession(null);
    selectedSessionTriggerRef.current?.focus();
  }
}

function buildChartData(sessions: DataResponse["sessions"], range: RangeFilter) {
  const formatter = range === "12m"
    ? (value: string) => value.slice(0, 7)
    : (value: string) => value.slice(5, 10);
  const grouped = new Map<string, { input: number; output: number; cacheCreation: number; cacheRead: number; cost: number }>();
  for (const session of sessions) {
    const label = formatter(session.createdAt);
    const bucket = grouped.get(label) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 };
    bucket.input += session.tokens.input;
    bucket.output += session.tokens.output;
    bucket.cacheCreation += session.tokens.cacheCreation;
    bucket.cacheRead += session.tokens.cacheRead;
    bucket.cost += session.cost.total;
    grouped.set(label, bucket);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, bucket]) => ({ label, ...bucket }));
}

function buildProjectData(projects: ProjectSummary[]) {
  return projects
    .map((project) => ({ name: project.projectLabel, value: project.totalCost }))
    .slice(0, 8);
}

function buildModelData(sessions: DataResponse["sessions"]) {
  const grouped = new Map<string, number>();
  for (const session of sessions) {
    if (session.modelUsage && Object.keys(session.modelUsage).length > 0) {
      // Distribute session cost proportionally across models by total tokens
      const totalTokens = Object.values(session.modelUsage).reduce(
        (sum, u) => sum + u.input + u.output + u.cacheCreation + u.cacheRead, 0,
      );
      if (totalTokens > 0) {
        for (const [model, usage] of Object.entries(session.modelUsage)) {
          const modelTokens = usage.input + usage.output + usage.cacheCreation + usage.cacheRead;
          const share = modelTokens / totalTokens;
          const name = shortenModelName(model);
          grouped.set(name, (grouped.get(name) ?? 0) + session.cost.total * share);
        }
        continue;
      }
    }
    // Fallback: attribute all cost to session.model (skip "unknown")
    const model = shortenModelName(session.model);
    if (model !== "unknown") {
      grouped.set(model, (grouped.get(model) ?? 0) + session.cost.total);
    }
  }
  return [...grouped.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 8);
}

function buildAgentData(sessions: DataResponse["sessions"]) {
  const grouped = new Map<string, number>();
  for (const session of sessions) {
    const label = SOURCE_LABELS[session.source] ?? session.source;
    grouped.set(label, (grouped.get(label) ?? 0) + session.cost.total);
  }
  return [...grouped.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value);
}

function buildTokenBreakdown(tokens?: DataResponse["totals"]["tokens"]) {
  if (!tokens) return [];
  return [
    { name: "Input Tokens", value: tokens.input },
    { name: "Output Tokens", value: tokens.output },
    { name: "Cache Write", value: tokens.cacheCreation },
    { name: "Cache Read", value: tokens.cacheRead },
  ];
}

function buildBreakdownChartData(items?: ProjectSummary["sourceBreakdown"]) {
  if (!items) return [];
  return items.map((item) => ({ name: item.label, value: item.cost }));
}

function shortenModelName(model: string): string {
  // Remove provider prefixes and simplify common model names
  return model
    .replace(/^(anthropic\.|openai\.|azure\/|claude-)/, "")
    .replace(/-20\d{6}$/, "")
    .replace(/-latest$/, "");
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(seconds: number): string {
  // Handle invalid/extreme values
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 365 * 24 * 3600) {
    return "—";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function getSessionKey(session: Pick<Session, "machineId" | "source" | "id">): string {
  return `${session.machineId}:${session.source}:${session.id}`;
}

function SourceFilter({ sources, value, onChange }: { sources: Source[]; value: Source | "all"; onChange: (v: Source | "all") => void }) {
  if (sources.length <= 1) return null;
  const options: Array<Source | "all"> = ["all", ...sources];
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            value === option ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
          onClick={() => onChange(option)}
        >
          {option === "all" ? "All Agents" : SOURCE_LABELS[option] ?? option}
        </button>
      ))}
    </div>
  );
}

function computeFilteredTotals(sessions: Session[]): DataResponse["totals"] {
  let totalCost = 0, inputCost = 0, outputCost = 0, cacheCreationCost = 0, cacheReadCost = 0;
  let inputTokens = 0, outputTokens = 0, cacheCreation = 0, cacheRead = 0;
  let turns = 0, durationSeconds = 0;

  for (const s of sessions) {
    totalCost += s.cost.total;
    inputCost += s.cost.input;
    outputCost += s.cost.output;
    cacheCreationCost += s.cost.cacheCreation;
    cacheReadCost += s.cost.cacheRead;
    inputTokens += s.tokens.input;
    outputTokens += s.tokens.output;
    cacheCreation += s.tokens.cacheCreation;
    cacheRead += s.tokens.cacheRead;
    turns += s.turns;
    durationSeconds += s.durationSeconds;
  }

  const totalInput = inputTokens + cacheCreation + cacheRead;
  const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

  return {
    sessions: sessions.length,
    turns,
    durationSeconds,
    tokens: { input: inputTokens, output: outputTokens, cacheCreation, cacheRead },
    cost: { input: inputCost, output: outputCost, cacheCreation: cacheCreationCost, cacheRead: cacheReadCost, total: totalCost },
    cacheHitRate,
  };
}

function buildFilteredProjects(sessions: Session[]): ProjectSummary[] {
  const grouped = new Map<string, Session[]>();
  for (const s of sessions) {
    const existing = grouped.get(s.project) ?? [];
    existing.push(s);
    grouped.set(s.project, existing);
  }

  return [...grouped.entries()]
    .map(([project, projectSessions]) => {
      let totalCost = 0, totalTurns = 0;
      const days = new Set<string>();
      const tokenBreakdown: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      const costBreakdown: CostBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
      const sourceMap = new Map<string, { cost: number; sessions: number }>();
      const modelMap = new Map<string, { cost: number; sessions: number }>();
      const machineMap = new Map<string, { cost: number; sessions: number }>();

      for (const s of projectSessions) {
        totalCost += s.cost.total;
        totalTurns += s.turns;
        days.add(s.createdAt.slice(0, 10));
        tokenBreakdown.input += s.tokens.input;
        tokenBreakdown.output += s.tokens.output;
        tokenBreakdown.cacheCreation += s.tokens.cacheCreation;
        tokenBreakdown.cacheRead += s.tokens.cacheRead;
        costBreakdown.input += s.cost.input;
        costBreakdown.output += s.cost.output;
        costBreakdown.cacheCreation += s.cost.cacheCreation;
        costBreakdown.cacheRead += s.cost.cacheRead;
        costBreakdown.total += s.cost.total;

        // Source breakdown
        const src = sourceMap.get(s.source) ?? { cost: 0, sessions: 0 };
        src.cost += s.cost.total;
        src.sessions += 1;
        sourceMap.set(s.source, src);

        // Model breakdown
        const model = s.model;
        if (model !== "unknown") {
          const m = modelMap.get(model) ?? { cost: 0, sessions: 0 };
          m.cost += s.cost.total;
          m.sessions += 1;
          modelMap.set(model, m);
        }

        // Machine breakdown
        const machine = s.machineId;
        const mc = machineMap.get(machine) ?? { cost: 0, sessions: 0 };
        mc.cost += s.cost.total;
        mc.sessions += 1;
        machineMap.set(machine, mc);
      }

      const totalTokens = tokenBreakdown.input + tokenBreakdown.output + tokenBreakdown.cacheCreation + tokenBreakdown.cacheRead;
      const toBreakdown = (map: Map<string, { cost: number; sessions: number }>) =>
        [...map.entries()]
          .map(([key, { cost, sessions }]) => ({ key, label: key, cost, sessions }))
          .sort((a, b) => b.cost - a.cost || b.sessions - a.sessions || a.label.localeCompare(b.label));

      const sourceBreakdown = toBreakdown(sourceMap);
      const modelBreakdown = toBreakdown(modelMap);
      const machineBreakdown = toBreakdown(machineMap);

      return {
        projectKey: project,
        projectLabel: project,
        totalCost,
        totalTokens,
        sessionCount: projectSessions.length,
        totalTurns,
        avgCostPerSession: totalCost / Math.max(projectSessions.length, 1),
        avgTurnsPerSession: totalTurns / Math.max(projectSessions.length, 1),
        activeDays: days.size,
        topSource: sourceBreakdown[0]?.label,
        topModel: modelBreakdown[0]?.label,
        topMachine: machineBreakdown[0]?.label,
        tokenBreakdown,
        costBreakdown,
        sourceBreakdown,
        modelBreakdown,
        machineBreakdown,
      } satisfies ProjectSummary;
    })
    .sort((a, b) => b.totalCost - a.totalCost || b.sessionCount - a.sessionCount || a.projectLabel.localeCompare(b.projectLabel));
}
