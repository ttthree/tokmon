import { useEffect, useState } from "react";

import type { AppConfig, SourceEntry, SourceType } from "../../core/types.js";
import {
  fetchMachineIdentity,
  fetchSettings,
  saveSettings,
  triggerCollect,
  type CollectSSEEvent,
  type MachineIdentity,
} from "../api.js";

const SOURCE_TYPES: Array<{ id: SourceType; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "copilot-cli", label: "Copilot CLI" },
  { id: "pi-agent", label: "PI Agent" },
  { id: "eureka", label: "Eureka" },
  { id: "mars", label: "Mars" },
];

export function SettingsTab() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [collectLog, setCollectLog] = useState<string[]>([]);
  const [collecting, setCollecting] = useState(false);

  // Working copies of mutable sections
  const [sources, setSources] = useState<SourceEntry[]>([]);
  const [excludeFoldersText, setExcludeFoldersText] = useState("");
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState("5");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [githubSyncIntervalMinutes, setGithubSyncIntervalMinutes] = useState("60");
  const [projectsJson, setProjectsJson] = useState("{}");
  const [projectsJsonError, setProjectsJsonError] = useState<string | null>(null);
  const [machineName, setMachineName] = useState("");
  const [machineIdentity, setMachineIdentity] = useState<MachineIdentity | null>(null);

  const [newType, setNewType] = useState<SourceType>("claude-code");
  const [newPath, setNewPath] = useState("");

  useEffect(() => {
    fetchSettings()
      .then((cfg) => {
        setConfig(cfg);
        setSources(cfg.sources);
        setExcludeFoldersText(cfg.excludeFolders.join("\n"));
        setRefreshIntervalMinutes(String(cfg.refresh.intervalMinutes || 5));
        setGithubRepo(cfg.github.repo);
        setGithubBranch(cfg.github.branch || "main");
        setGithubSyncIntervalMinutes(String(cfg.github.syncIntervalMinutes || 60));
        setProjectsJson(JSON.stringify(cfg.projects, null, 2));
        setMachineName(cfg.machine?.name ?? "");
      })
      .catch((err: Error) => setLoadError(err.message));
    fetchMachineIdentity()
      .then((id) => setMachineIdentity(id))
      .catch(() => {
        // Non-fatal: panel just won't show the ID.
      });
  }, []);

  function toggleSource(id: string) {
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  }

  function deleteSource(id: string) {
    setSources((prev) => prev.filter((s) => !(s.id === id && !s.autoDetected)));
  }

  function addSource() {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    const id = `${newType}:${trimmed}`;
    if (sources.some((s) => s.id === id)) return;
    setSources((prev) => [
      ...prev,
      { id, type: newType, path: trimmed, enabled: true, autoDetected: false },
    ]);
    setNewPath("");
  }

  async function handleSave() {
    let projects: AppConfig["projects"];
    try {
      projects = JSON.parse(projectsJson) as AppConfig["projects"];
      setProjectsJsonError(null);
    } catch (err) {
      setProjectsJsonError((err as Error).message);
      return;
    }
    const excludeFolders = excludeFoldersText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      const updated = await saveSettings({
        sources,
        excludeFolders,
        refresh: { intervalMinutes: parseIntervalMinutes(refreshIntervalMinutes, 5) },
        github: {
          repo: githubRepo.trim(),
          branch: githubBranch.trim() || "main",
          syncIntervalMinutes: parseIntervalMinutes(githubSyncIntervalMinutes, 60),
        },
        projects,
        machine: { name: machineName.trim() || undefined },
      });
      setConfig(updated);
      setSources(updated.sources);
      setRefreshIntervalMinutes(String(updated.refresh.intervalMinutes || 5));
      setMachineName(updated.machine?.name ?? "");
      setGithubSyncIntervalMinutes(String(updated.github.syncIntervalMinutes || 60));
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAndCollect() {
    await handleSave();
    setCollectLog([]);
    setCollecting(true);
    try {
      await triggerCollect(false, (event) => {
        setCollectLog((prev) => [...prev, formatEvent(event)]);
      });
    } catch (err) {
      setCollectLog((prev) => [...prev, `error: ${(err as Error).message}`]);
    } finally {
      setCollecting(false);
    }
  }

  if (loadError) {
    return (
      <section className="rounded-2xl border p-4" style={panelStyle}>
        <div className="text-sm text-rose-700">{loadError}</div>
      </section>
    );
  }
  if (!config) {
    return (
      <section className="rounded-2xl border p-4" style={panelStyle}>
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title="This machine" description="Controls how this machine is labelled in the dashboard. The ID is fixed and used as the data file key.">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            Machine ID
            <input
              value={machineIdentity?.id ?? ""}
              readOnly
              className="rounded border px-2 py-1 font-mono text-xs"
              style={{ ...inputStyle, opacity: 0.7 }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            Friendly name
            <input
              value={machineName}
              onChange={(e) => setMachineName(e.target.value)}
              placeholder={machineIdentity?.hostname ?? "hostname"}
              className="rounded border px-2 py-1 text-sm"
              style={inputStyle}
            />
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Leave blank to use this machine's hostname
              {machineIdentity?.hostname ? ` (${machineIdentity.hostname})` : ""}.
            </span>
          </label>
        </div>
      </Panel>

      <Panel title="Data sources" description="Tokmon scans these directories for agent sessions.">
        <div className="flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
          {sources.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  <span>{typeLabel(s.type)}</span>
                  {s.autoDetected ? (
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={badgeStyle}>
                      Auto
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-xs" style={{ color: "var(--text-muted)" }} title={s.path}>
                  {s.path}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                <input type="checkbox" checked={s.enabled} onChange={() => toggleSource(s.id)} />
                Enabled
              </label>
              {!s.autoDetected ? (
                <button
                  type="button"
                  onClick={() => deleteSource(s.id)}
                  className="rounded px-2 py-1 text-xs"
                  style={{ borderColor: "var(--border)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as SourceType)}
            className="rounded border px-2 py-1 text-sm"
            style={inputStyle}
          >
            {SOURCE_TYPES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          <input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="/absolute/path/to/source"
            className="flex-1 rounded border px-2 py-1 text-sm"
            style={inputStyle}
          />
          <button type="button" onClick={addSource} className="rounded px-3 py-1 text-sm" style={primaryButtonStyle}>
            Add source
          </button>
        </div>
      </Panel>

      <Panel title="Excluded folders" description="One pattern per line. Sessions matching these are labelled as 'other'.">
        <textarea
          value={excludeFoldersText}
          onChange={(e) => setExcludeFoldersText(e.target.value)}
          rows={5}
          className="w-full rounded border px-2 py-1 font-mono text-xs"
          style={inputStyle}
        />
      </Panel>

      <Panel title="Background refresh" description="Control how often tokmon recollects local data while the dashboard is running.">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            Refresh interval (minutes)
            <input
              type="number"
              min={1}
              step={1}
              value={refreshIntervalMinutes}
              onChange={(e) => setRefreshIntervalMinutes(e.target.value)}
              className="rounded border px-2 py-1 text-sm"
              style={inputStyle}
            />
          </label>
        </div>
      </Panel>

      <Panel title="Projects" description="JSON map of project name → { folders: [], description?: '' }.">
        <textarea
          value={projectsJson}
          onChange={(e) => setProjectsJson(e.target.value)}
          rows={8}
          className="w-full rounded border px-2 py-1 font-mono text-xs"
          style={inputStyle}
        />
        {projectsJsonError ? (
          <div className="mt-1 text-xs text-rose-700">{projectsJsonError}</div>
        ) : null}
      </Panel>

      <Panel title="GitHub sync" description="Optional: push anonymized data to a private GitHub repo for cross-machine sync. Accepts owner/name, HTTPS URLs, or SSH remotes.">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            Repo (owner/name or remote)
            <input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="myuser/tokmon-data or git@gh:myuser/tokmon-data"
              className="rounded border px-2 py-1 text-sm"
              style={inputStyle}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            Branch
            <input
              value={githubBranch}
              onChange={(e) => setGithubBranch(e.target.value)}
              className="rounded border px-2 py-1 text-sm"
              style={inputStyle}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            Sync interval (minutes)
            <input
              type="number"
              min={1}
              step={1}
              value={githubSyncIntervalMinutes}
              onChange={(e) => setGithubSyncIntervalMinutes(e.target.value)}
              className="rounded border px-2 py-1 text-sm"
              style={inputStyle}
            />
          </label>
        </div>
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={handleSave} disabled={saving || collecting} className="rounded px-4 py-2 text-sm font-medium" style={secondaryButtonStyle}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={handleSaveAndCollect} disabled={saving || collecting} className="rounded px-4 py-2 text-sm font-medium" style={primaryButtonStyle}>
          {collecting ? "Collecting…" : "Save & Re-collect"}
        </button>
      </div>

      {collectLog.length > 0 ? (
        <Panel title="Collect progress">
          <pre className="max-h-64 overflow-auto rounded p-2 font-mono text-xs" style={{ background: "var(--bg-panel-muted)", color: "var(--text-secondary)" }}>
            {collectLog.join("\n")}
          </pre>
        </Panel>
      ) : null}
    </div>
  );
}

function formatEvent(e: CollectSSEEvent): string {
  switch (e.phase) {
    case "pricing":
      return `pricing: ${e.detail}`;
    case "source-start":
      return `${e.source}: scanning…`;
    case "source-progress":
      return `${e.source}: ${e.detail}`;
    case "source-done":
      return `${e.source}: ✓ ${e.count} sessions (${e.ms}ms)`;
    case "save":
      return `save: ${e.detail}`;
    case "complete":
      return `complete: ${e.sessionCount} sessions in ${e.durationMs}ms`;
    case "error":
      return `error: ${e.message}`;
  }
}

function typeLabel(t: SourceType): string {
  return SOURCE_TYPES.find((s) => s.id === t)?.label ?? t;
}

function parseIntervalMinutes(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border p-4" style={panelStyle}>
      <div className="mb-3">
        <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</div>
        {description ? (
          <div className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>{description}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const panelStyle: React.CSSProperties = {
  background: "var(--bg-panel)",
  borderColor: "var(--border)",
  borderRadius: "var(--radius-card)",
  boxShadow: "var(--shadow-card)",
};

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  borderColor: "var(--border)",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-fg)",
  border: "1px solid var(--border)",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "var(--bg-panel-muted)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
};

const badgeStyle: React.CSSProperties = {
  background: "var(--bg-panel-muted)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
};
