import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CostBreakdown, DataResponse, ProjectSummary, Session, Source, TokenBreakdown } from "../core/types.js";
import { fetchDashboardData, fetchMachineIdentity, triggerCollect } from "./api.js";
import { ActiveFiltersBar } from "./components/ActiveFiltersBar.js";
import { BreakdownChart } from "./components/BreakdownChart.js";
import { BurnClock } from "./components/BurnClock.js";
import { IconDropdown } from "./components/IconDropdown.js";
import { ProjectActivityTable } from "./components/ProjectActivityTable.js";
import { ProjectDetailCard } from "./components/ProjectDetailCard.js";
import { SessionDetailModal } from "./components/SessionDetailModal.js";
import { LogsTab, type LogEntry } from "./components/LogsTab.js";
import { SessionTable } from "./components/SessionTable.js";
import { SettingsTab } from "./components/SettingsTab.js";
import { StatCard } from "./components/StatCard.js";
import { ThemePicker } from "./components/ThemePicker.js";
import { VersionBadge } from "./components/VersionBadge.js";
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
  mars: "Mars",
};

type AgentFilter = Source | "mars" | "all";
type Tab = "overview" | "projects" | "sessions" | "logs" | "settings";

const LOGS_STORAGE_KEY = "tokmon:change-log:v1";
const LOGS_MAX_ENTRIES = 1000;

interface LogSnapshot {
  sessions: number;
  turns: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
}

function totalsToSnapshot(totals: DataResponse["totals"]): LogSnapshot {
  return {
    sessions: totals.sessions,
    turns: totals.turns,
    cost: totals.cost.total,
    inputTokens: totals.tokens.input,
    outputTokens: totals.tokens.output,
    cacheCreation: totals.tokens.cacheCreation,
    cacheRead: totals.tokens.cacheRead,
  };
}

function diffSnapshot(prev: LogSnapshot, next: LogSnapshot) {
  return {
    sessions: next.sessions - prev.sessions,
    turns: next.turns - prev.turns,
    cost: next.cost - prev.cost,
    tokens: {
      input: next.inputTokens - prev.inputTokens,
      output: next.outputTokens - prev.outputTokens,
      cacheCreation: next.cacheCreation - prev.cacheCreation,
      cacheRead: next.cacheRead - prev.cacheRead,
    },
  };
}

function isMeaningfulDelta(delta: ReturnType<typeof diffSnapshot>): boolean {
  if (delta.sessions !== 0) return true;
  if (delta.turns !== 0) return true;
  if (Math.abs(delta.cost) >= 0.0005) return true;
  if (delta.tokens.input !== 0) return true;
  if (delta.tokens.output !== 0) return true;
  if (delta.tokens.cacheCreation !== 0) return true;
  if (delta.tokens.cacheRead !== 0) return true;
  return false;
}

const AGENT_FILTER_LABELS: Record<Exclude<AgentFilter, "all">, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot CLI",
  eureka: "Eureka",
  mars: "Mars",
};

export function App() {
  const [range, setRange] = useState<RangeFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<AgentFilter>("all");
  const [machineFilter, setMachineFilter] = useState<string | "all">("all");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [data, setData] = useState<DataResponse | null>(null);
  const [localMachineId, setLocalMachineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  // Bumped only when data arrives from a background poll (not from
  // initial load or filter changes). Consumed by StatCard to decide
  // whether to play the delta animation.
  const [refreshToken, setRefreshToken] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const collectingRef = useRef(false);
  const selectedSessionTriggerRef = useRef<HTMLElement | null>(null);
  // Snapshot of the last seen totals; used to compute deltas for the Logs tab.
  const lastSnapshotRef = useRef<LogSnapshot | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>(() => loadStoredLogs());

  useEffect(() => {
    try {
      const trimmed = logEntries.slice(-LOGS_MAX_ENTRIES);
      window.localStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // localStorage may be unavailable (private mode); fail silently.
    }
  }, [logEntries]);

  const recordSnapshot = useCallback(
    (totals: DataResponse["totals"], trigger: LogEntry["trigger"]) => {
      const snapshot = totalsToSnapshot(totals);
      const previous = lastSnapshotRef.current;
      lastSnapshotRef.current = snapshot;
      if (!previous) return; // First observation — nothing to diff against.
      const delta = diffSnapshot(previous, snapshot);
      if (!isMeaningfulDelta(delta)) return;
      const entry: LogEntry = { at: new Date().toISOString(), trigger, delta };
      setLogEntries((current) => {
        const next = [...current, entry];
        if (next.length > LOGS_MAX_ENTRIES) next.splice(0, next.length - LOGS_MAX_ENTRIES);
        return next;
      });
    },
    [],
  );

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    if (range === "7d") params.set("days", "7");
    if (range === "30d") params.set("days", "30");
    if (range === "12m") params.set("months", "12");
    return params;
  }, [range]);

  // Shared refresh: run collect, reload data, bump token for animation.
  // Serialized via collectingRef so rapid clicks / overlapping polls
  // don't pile up.
  const refreshNow = useCallback(async (trigger: LogEntry["trigger"] = "manual") => {
    if (collectingRef.current) return;
    collectingRef.current = true;
    setIsRefreshing(true);
    try {
      await triggerCollect(false, () => {});
      const response = await fetchDashboardData(buildParams());
      setData(response);
      setError(null);
      setRefreshToken((token) => token + 1);
      recordSnapshot(response.totals, trigger);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      collectingRef.current = false;
      setIsRefreshing(false);
    }
  }, [buildParams, recordSnapshot]);

  // Identify the local machine so SessionTable can disable rows for sessions
  // collected on remote machines (their source files aren't reachable here).
  useEffect(() => {
    let cancelled = false;
    fetchMachineIdentity()
      .then((identity) => {
        if (!cancelled) setLocalMachineId(identity.id);
      })
      .catch(() => {
        // Falling back to null keeps everything clickable — the API will
        // still 404 cleanly if the user opens a remote session.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const params = buildParams();
    let cancelled = false;

    // Initial render: just read whatever's cached, no collect, no animation.
    fetchDashboardData(params)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError(null);
        recordSnapshot(response.totals, "initial");
      })
      .catch((loadError: Error) => {
        if (cancelled) return;
        setError(loadError.message);
      });

    const intervalId = window.setInterval(() => {
      if (cancelled) return;
      void refreshNow("poll");
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [buildParams, refreshNow]);

  // Clear selected project and model filter when source filter changes
  useEffect(() => {
    setSelectedProject(null);
    setModelFilter(null);
  }, [sourceFilter]);

  // Reset machine filter if the chosen machine disappears from data
  useEffect(() => {
    if (!data) return;
    if (machineFilter === "all") return;
    if (!data.machines.some((m) => m.machineId === machineFilter)) {
      setMachineFilter("all");
    }
  }, [data, machineFilter]);

  // Clear model filter when selected project changes (charts repopulate)
  useEffect(() => {
    setModelFilter(null);
  }, [selectedProject]);

  // Derive available agent filters (sub-agent sources + Mars orchestrator if present)
  const availableSources = useMemo((): AgentFilter[] => {
    if (!data) return [];
    const sources = new Set(data.sessions.map((s) => s.source));
    const ordered: AgentFilter[] = (["claude-code", "codex", "copilot-cli", "eureka"] as Source[]).filter((s) =>
      sources.has(s),
    );
    if (data.sessions.some((s) => s.orchestrator?.kind === "mars")) {
      ordered.push("mars");
    }
    return ordered;
  }, [data]);

  // Apply agent + machine filters before all other computations
  const sourceSessions = useMemo(() => {
    if (!data) return [];
    let result = data.sessions;
    if (sourceFilter !== "all") {
      if (sourceFilter === "mars") {
        result = result.filter((s) => s.orchestrator?.kind === "mars");
      } else {
        result = result.filter((s) => s.source === sourceFilter);
      }
    }
    if (machineFilter !== "all") {
      result = result.filter((s) => s.machineId === machineFilter);
    }
    return result;
  }, [data, sourceFilter, machineFilter]);

  // Recompute totals for filtered sessions
  const filteredTotals = useMemo((): DataResponse["totals"] | undefined => {
    if (!data) return undefined;
    if (sourceFilter === "all" && machineFilter === "all") return data.totals;
    return computeFilteredTotals(sourceSessions);
  }, [data, sourceFilter, machineFilter, sourceSessions]);

  // Recompute projects for filtered sessions
  const sourceProjects = useMemo(() => {
    if (!data) return [];
    if (sourceFilter === "all" && machineFilter === "all") return data.projects;
    const machineNames = new Map(data.machines.map((m) => [m.machineId, m.name]));
    return buildFilteredProjects(sourceSessions, machineNames);
  }, [data, sourceFilter, machineFilter, sourceSessions]);

  // Validate selectedProject against the *filtered* project set so a project
  // that disappears under the current agent/machine filters doesn't keep
  // silently narrowing visibleSessions (the chip would also vanish, leaving
  // the user with no way to clear the hidden filter).
  useEffect(() => {
    if (selectedProject === null) return;
    if (!sourceProjects.some((project) => project.projectKey === selectedProject)) {
      setSelectedProject(null);
    }
  }, [sourceProjects, selectedProject]);

  const visibleSessions = useMemo(() => {
    let result = sourceSessions;
    if (selectedProject) {
      result = result.filter((session) => session.project === selectedProject);
    }
    if (modelFilter) {
      result = result.filter((session) => sessionMatchesModel(session, modelFilter));
    }
    return result;
  }, [sourceSessions, selectedProject, modelFilter]);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return visibleSessions;
    return visibleSessions.filter((session) => {
      const haystack = [session.project, session.summary ?? "", session.firstPrompt ?? "", session.model].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [search, visibleSessions]);

  const visibleProjects = useMemo(() => getVisibleProjects(sourceProjects, projectSearch), [sourceProjects, projectSearch]);

  const machineNames = useMemo(
    () => new Map((data?.machines ?? []).map((m) => [m.machineId, m.name])),
    [data?.machines],
  );

  const chartData = useMemo(() => buildChartData(sourceSessions, range), [sourceSessions, range]);
  const projectChartData = useMemo(() => {
    if (!selectedProject) return { points: [], sources: [] };
    return buildChartData(
      sourceSessions.filter((s) => s.project === selectedProject),
      range,
    );
  }, [sourceSessions, selectedProject, range]);
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
  const selectedProjectLabel = selectedProjectSummary?.projectLabel ?? null;
  const agentSelectedLabel = sourceFilter === "all" ? null : AGENT_FILTER_LABELS[sourceFilter] ?? null;
  const machineSelectedLabel =
    machineFilter === "all" ? null : machineNames.get(machineFilter) ?? machineFilter;

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
    <main
      className="min-h-screen px-4 pb-24 pt-8 sm:px-6 lg:px-10"
      style={{ background: "var(--bg-app)", color: "var(--text-primary)", fontFamily: "var(--font-body)" }}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header
          className="flex flex-col gap-3 rounded-3xl border px-6 py-3 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between"
          style={{ background: "var(--bg-panel)", borderColor: "var(--border)", borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-card)" }}
        >
          <div className="flex items-center gap-3">
            <div
              className="flex items-center text-[11px] font-semibold uppercase tracking-[0.25em]"
              style={{ color: "var(--header-eyebrow)" }}
            >
              <span>TOKMON</span>
              <VersionBadge />
            </div>
            <span aria-hidden className="hidden sm:block h-5 w-px" style={{ background: "var(--border)" }} />
            <TabBar value={tab} onChange={setTab} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SourceFilter sources={availableSources} value={sourceFilter} onChange={setSourceFilter} />
            <MachineFilter
              machines={data?.machines ?? []}
              value={machineFilter}
              onChange={setMachineFilter}
              localMachineId={localMachineId}
            />
            <TimeFilter value={range} onChange={setRange} />
            <span aria-hidden className="hidden sm:block h-5 w-px mx-1" style={{ background: "var(--border)" }} />
            <RefreshButton isRefreshing={isRefreshing} onClick={() => void refreshNow("manual")} />
            <ThemePicker />
          </div>
        </header>

        {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

        {tab === "overview" ? (
          <>
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                testId="total-cost"
                label="Total Cost"
                value={formatCurrency(filteredTotals?.cost.total ?? 0)}
                numericValue={filteredTotals?.cost.total ?? 0}
                formatDelta={formatCurrencyDelta}
                deltaEpsilon={0.0005}
                refreshToken={refreshToken}
              />
              <StatCard
                label="Sessions"
                value={String(filteredTotals?.sessions ?? 0)}
                numericValue={filteredTotals?.sessions ?? 0}
                formatDelta={formatIntDelta}
                refreshToken={refreshToken}
              />
              <StatCard
                label="Turns"
                value={formatInteger(filteredTotals?.turns ?? 0)}
                numericValue={filteredTotals?.turns ?? 0}
                formatDelta={formatIntDelta}
                refreshToken={refreshToken}
              />
              <StatCard
                label="Cache Hit Rate"
                value={formatPercent(filteredTotals?.cacheHitRate ?? 0)}
                numericValue={filteredTotals?.cacheHitRate ?? 0}
                formatDelta={formatPercentDelta}
                deltaEpsilon={0.0005}
                refreshToken={refreshToken}
              />
            </section>

            <section>
              <TokenChart
                data={chartData.points}
                sources={sourceFilter === "all" ? chartData.sources : undefined}
                sourceLabels={SOURCE_LABELS}
              />
            </section>

            <section className="grid gap-4 xl:grid-cols-[320px_1fr] items-stretch">
              <div className="grid grid-cols-2 grid-rows-2 gap-4">
                {tokenBreakdown.map((item) => (
                  <StatCard key={item.name} label={item.name} value={formatCompact(item.value)} />
                ))}
              </div>
              <BurnClock sessions={visibleSessions} formatCurrency={formatCurrency} />
            </section>
          </>
        ) : tab === "projects" ? (
          <>
            <section>
              <ProjectActivityTable
                projects={visibleProjects}
                sessions={sourceSessions}
                searchQuery={projectSearch}
                selectedProject={selectedProject}
                onSelect={setSelectedProject}
                onSearchChange={setProjectSearch}
                formatCurrency={formatCurrency}
              />
            </section>

            <section>
              <ProjectDetailCard
                project={selectedProjectSummary}
                onClear={() => setSelectedProject(null)}
                formatCurrency={formatCurrency}
                formatPercent={formatPercent}
              />
            </section>

            {selectedProjectSummary ? (
              <section>
                <TokenChart
                  data={projectChartData.points}
                  sources={sourceFilter === "all" ? projectChartData.sources : undefined}
                  sourceLabels={SOURCE_LABELS}
                  title={`Token & Cost Trend — ${selectedProjectSummary.projectLabel}`}
                />
              </section>
            ) : null}

            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {selectedProjectSummary ? (
                <>
                  <BreakdownChart testId="source-breakdown" title="Cost by Source" data={selectedSourceData} formatValue={(v) => `$${v.toFixed(2)}`} />
                  <BreakdownChart
                    testId="selected-model-breakdown"
                    title="Cost by Model"
                    data={selectedModelData}
                    formatValue={(v) => `$${v.toFixed(2)}`}
                    selectedName={modelFilter}
                    onSelect={setModelFilter}
                  />
                  <BreakdownChart testId="machine-breakdown" title="Cost by Machine" data={selectedMachineData} formatValue={(v) => `$${v.toFixed(2)}`} />
                </>
              ) : (
                <>
                  <BreakdownChart
                    testId="project-breakdown"
                    title="Cost by Project"
                    data={projectData}
                    formatValue={(v) => `$${v.toFixed(2)}`}
                    selectedName={selectedProjectLabel}
                    onSelect={(name) => {
                      if (name == null) {
                        setSelectedProject(null);
                        return;
                      }
                      const match = sourceProjects.find((p) => p.projectLabel === name);
                      setSelectedProject(match ? match.projectKey : null);
                    }}
                  />
                  <BreakdownChart
                    testId="model-breakdown"
                    title="Cost by Model"
                    data={modelData}
                    formatValue={(v) => `$${v.toFixed(2)}`}
                    selectedName={modelFilter}
                    onSelect={setModelFilter}
                  />
                  <BreakdownChart
                    testId="agent-breakdown"
                    title="Cost by Agent"
                    data={agentData}
                    formatValue={(v) => `$${v.toFixed(2)}`}
                    selectedName={agentSelectedLabel}
                    onSelect={(name) => {
                      if (name == null) {
                        setSourceFilter("all");
                        return;
                      }
                      const entry = (Object.entries(SOURCE_LABELS) as Array<[Source, string]>).find(
                        ([, label]) => label === name,
                      );
                      setSourceFilter(entry ? entry[0] : "all");
                    }}
                  />
                </>
              )}
            </section>
          </>
        ) : tab === "sessions" ? (
          <section
            className="rounded-2xl border p-4"
            style={{ background: "var(--bg-panel)", borderColor: "var(--border)", borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
                  Sessions
                </div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {buildSessionsSubtitle(selectedProjectSummary?.projectLabel, modelFilter, agentSelectedLabel)}
                </div>
              </div>
              <input
                data-testid="search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search project, prompt, or model"
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none ring-0 sm:max-w-xs"
                style={{
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  borderColor: "var(--border)",
                }}
              />
            </div>
            <SessionTable
              sessions={filteredSessions}
              localMachineId={localMachineId}
              machineNames={machineNames}
              onSelect={(session, trigger) => {
                selectedSessionTriggerRef.current = trigger;
                setSelectedSession(session);
              }}
            />
          </section>
        ) : tab === "logs" ? (
          <LogsTab
            entries={logEntries}
            formatCurrency={formatCurrency}
            onClear={() => setLogEntries([])}
          />
        ) : (
          <SettingsTab />
        )}
      </div>
      {selectedSession ? <SessionDetailModal session={selectedSession} onClose={handleCloseSessionModal} formatCurrency={formatCurrency} /> : null}
      <ActiveFiltersBar
        range={range}
        onClearRange={() => setRange("all")}
        sourceLabel={agentSelectedLabel}
        onClearSource={() => setSourceFilter("all")}
        machineLabel={machineSelectedLabel}
        onClearMachine={() => setMachineFilter("all")}
        projectLabel={selectedProjectSummary?.projectLabel ?? null}
        onClearProject={() => setSelectedProject(null)}
        modelLabel={modelFilter}
        onClearModel={() => setModelFilter(null)}
        search={search}
        onClearSearch={() => setSearch("")}
        projectSearch={projectSearch}
        onClearProjectSearch={() => setProjectSearch("")}
        onClearAll={() => {
          setRange("all");
          setSourceFilter("all");
          setMachineFilter("all");
          setSelectedProject(null);
          setModelFilter(null);
          setSearch("");
          setProjectSearch("");
        }}
      />
    </main>
  );

  function handleCloseSessionModal() {
    setSelectedSession(null);
    selectedSessionTriggerRef.current?.focus();
  }
}

function buildChartData(sessions: DataResponse["sessions"], range: RangeFilter) {
  const isMonthly = range === "12m";
  const formatter = isMonthly
    ? (value: string) => value.slice(0, 7)
    : (value: string) => value.slice(5, 10);
  const grouped = new Map<string, { input: number; output: number; cacheCreation: number; cacheRead: number; cost: number; costBySource: Record<string, number> }>();
  // Track which sources actually appear so the chart only renders bars for them.
  const sourcesSeen = new Set<string>();
  // Track full ISO date so we can compute span for filling gaps
  const seenIso: string[] = [];
  for (const session of sessions) {
    const iso = session.createdAt.slice(0, 10); // YYYY-MM-DD
    const label = formatter(session.createdAt);
    const bucket = grouped.get(label) ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0, costBySource: {} };
    bucket.input += session.tokens.input;
    bucket.output += session.tokens.output;
    bucket.cacheCreation += session.tokens.cacheCreation;
    bucket.cacheRead += session.tokens.cacheRead;
    bucket.cost += session.cost.total;
    if (session.tokens.input > 0 || session.tokens.output > 0 || session.tokens.cacheCreation > 0 || session.tokens.cacheRead > 0 || session.cost.total > 0) {
      seenIso.push(iso);
    }
    const src = session.source;
    bucket.costBySource[src] = (bucket.costBySource[src] ?? 0) + session.cost.total;
    sourcesSeen.add(src);
    grouped.set(label, bucket);
  }

  // Build the full label list so chart x-axis includes every day/month in the
  // selected range — even if there are no sessions on a given day.
  const labels = buildContinuousLabels(range, seenIso, isMonthly);
  const empty = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0, costBySource: {} as Record<string, number> };
  const points = labels.map((label) => ({ label, ...(grouped.get(label) ?? empty) }));
  const sources = [...sourcesSeen].sort();
  return { points, sources };
}

function buildContinuousLabels(range: RangeFilter, seenIso: string[], isMonthly: boolean): string[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Determine [start, end] anchor based on range; for "all", fall back to data span.
  let start: Date;
  let end: Date = today;
  if (range === "7d") {
    start = new Date(today);
    start.setDate(start.getDate() - 6);
  } else if (range === "30d") {
    start = new Date(today);
    start.setDate(start.getDate() - 29);
  } else if (range === "12m") {
    start = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    end = new Date(today.getFullYear(), today.getMonth(), 1);
  } else {
    // "all": span the data we actually have
    if (seenIso.length === 0) return [];
    const sorted = [...seenIso].sort();
    start = new Date(sorted[0] + "T00:00:00");
    end = new Date(sorted[sorted.length - 1] + "T00:00:00");
    if (isMonthly) {
      start = new Date(start.getFullYear(), start.getMonth(), 1);
      end = new Date(end.getFullYear(), end.getMonth(), 1);
    }
  }

  const labels: string[] = [];
  if (isMonthly) {
    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      labels.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`);
      cur.setMonth(cur.getMonth() + 1);
    }
  } else {
    const cur = new Date(start);
    while (cur <= end) {
      labels.push(`${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
      cur.setDate(cur.getDate() + 1);
    }
  }
  return labels;
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

function sessionMatchesModel(session: Session, modelLabel: string): boolean {
  const matches = (name: string) => name === modelLabel || shortenModelName(name) === modelLabel;
  if (session.modelUsage && Object.keys(session.modelUsage).length > 0) {
    for (const name of Object.keys(session.modelUsage)) {
      if (matches(name)) return true;
    }
    return false;
  }
  return matches(session.model);
}

function buildSessionsSubtitle(project: string | undefined, model: string | null, agent: string | null): string {
  const filters: string[] = [];
  if (project) filters.push(`project: ${project}`);
  if (agent) filters.push(`agent: ${agent}`);
  if (model) filters.push(`model: ${model}`);
  if (filters.length === 0) return "Showing sessions for all projects in range.";
  return `Filtered by ${filters.join(" · ")}.`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCurrencyDelta(delta: number): string {
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${formatCurrency(Math.abs(delta))}`;
}

function formatIntDelta(delta: number): string {
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${formatInteger(Math.abs(delta))}`;
}

function formatPercentDelta(delta: number): string {
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${(Math.abs(delta) * 100).toFixed(1)}pp`;
}

function getSessionKey(session: Pick<Session, "machineId" | "source" | "id">): string {
  return `${session.machineId}:${session.source}:${session.id}`;
}

function loadStoredLogs(): LogEntry[] {
  try {
    const raw = window.localStorage.getItem(LOGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLogEntry).slice(-LOGS_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<LogEntry>;
  if (typeof v.at !== "string") return false;
  if (v.trigger !== "initial" && v.trigger !== "poll" && v.trigger !== "manual") return false;
  const d = v.delta as LogEntry["delta"] | undefined;
  if (!d || typeof d !== "object") return false;
  if (typeof d.sessions !== "number") return false;
  if (typeof d.turns !== "number") return false;
  if (typeof d.cost !== "number") return false;
  if (!d.tokens || typeof d.tokens !== "object") return false;
  return (
    typeof d.tokens.input === "number" &&
    typeof d.tokens.output === "number" &&
    typeof d.tokens.cacheCreation === "number" &&
    typeof d.tokens.cacheRead === "number"
  );
}

function TabBar({ value, onChange }: { value: Tab; onChange: (v: Tab) => void }) {
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "projects", label: "Projects" },
    { id: "sessions", label: "Sessions" },
    { id: "logs", label: "Logs" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <div
      className="inline-flex h-8 self-start rounded-md border p-0.5"
      style={{ background: "var(--bg-panel)", borderColor: "var(--border)" }}
    >
      {tabs.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            className="rounded-[5px] px-3 text-xs font-medium leading-none transition flex items-center"
            style={{
              background: active ? "var(--accent)" : "transparent",
              color: active ? "var(--accent-fg)" : "var(--text-secondary)",
            }}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function RefreshButton({ isRefreshing, onClick }: { isRefreshing: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isRefreshing}
      aria-label={isRefreshing ? "Refreshing" : "Refresh now"}
      title={isRefreshing ? "Refreshing…" : "Refresh now"}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border outline-none transition disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        color: "var(--text-primary)",
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          animation: isRefreshing ? "tokmon-spin 0.9s linear infinite" : undefined,
        }}
      >
        <path d="M21 12a9 9 0 0 1-15.5 6.4L3 16" />
        <path d="M3 12a9 9 0 0 1 15.5-6.4L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M3 21v-5h5" />
      </svg>
    </button>
  );
}

function SourceFilter({
  sources,
  value,
  onChange,
}: {
  sources: AgentFilter[];
  value: AgentFilter;
  onChange: (v: AgentFilter) => void;
}) {
  if (sources.length === 0) return null;
  // Single-agent environments: still render the icon dropdown so the row
  // height stays consistent, but with only the one option.
  const options = (["all", ...sources] as AgentFilter[]).map((option) => ({
    value: option,
    label: option === "all" ? "All agents" : AGENT_FILTER_LABELS[option] ?? option,
  }));
  return (
    <IconDropdown
      ariaLabel="Agent"
      menuTitle="Agent"
      icon={<AgentIcon />}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}

function MachineFilter({
  machines,
  value,
  onChange,
  localMachineId,
}: {
  machines: Array<{ machineId: string; name: string }>;
  value: string | "all";
  onChange: (v: string | "all") => void;
  localMachineId: string | null;
}) {
  if (machines.length <= 1) return null;
  const options: Array<{ value: string; label: string; description?: string }> = [
    { value: "all", label: "All machines" },
    ...machines
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => ({
        value: m.machineId,
        label: m.name,
        description: m.machineId === localMachineId ? "this machine" : undefined,
      })),
  ];
  return (
    <IconDropdown
      ariaLabel="Machine"
      menuTitle="Machine"
      icon={<MachineIcon />}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}

function AgentIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="7" width="16" height="12" rx="2" />
      <path d="M12 3v4" />
      <circle cx="12" cy="2" r="1" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
      <path d="M9 17h6" />
    </svg>
  );
}

function MachineIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
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

function buildFilteredProjects(sessions: Session[], machineNames?: Map<string, string>): ProjectSummary[] {
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
      const machineBreakdown = [...machineMap.entries()]
        .map(([key, { cost, sessions }]) => ({ key, label: machineNames?.get(key) ?? key, cost, sessions }))
        .sort((a, b) => b.cost - a.cost || b.sessions - a.sessions || a.label.localeCompare(b.label));

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
