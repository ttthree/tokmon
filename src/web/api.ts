import type { AppConfig, DataResponse, SourceEntry } from "../core/types.js";
import type { SessionMessages } from "../core/messages.js";

export async function fetchDashboardData(search: URLSearchParams): Promise<DataResponse> {
  const response = await fetch(`/api/data?${search.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to load dashboard data: ${response.status}`);
  }
  return response.json() as Promise<DataResponse>;
}

export async function fetchSessionMessages(machineId: string, source: string, id: string): Promise<SessionMessages> {
  const response = await fetch(`/api/session/${encodeURIComponent(machineId)}/${encodeURIComponent(source)}/${encodeURIComponent(id)}/messages`);
  if (!response.ok) {
    throw new Error(response.status === 404 ? "Session not found" : `Failed to load session messages: ${response.status}`);
  }
  return response.json() as Promise<SessionMessages>;
}

export async function fetchSettings(): Promise<AppConfig> {
  const response = await fetch("/api/settings");
  if (!response.ok) throw new Error(`Failed to load settings: ${response.status}`);
  return response.json() as Promise<AppConfig>;
}

export interface MachineIdentity {
  id: string;
  hostname: string;
  name: string;
}

export async function fetchMachineIdentity(): Promise<MachineIdentity> {
  const response = await fetch("/api/machine");
  if (!response.ok) throw new Error(`Failed to load machine identity: ${response.status}`);
  return response.json() as Promise<MachineIdentity>;
}

export async function saveSettings(config: Partial<AppConfig>): Promise<AppConfig> {
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) throw new Error(`Failed to save settings: ${response.status}`);
  return response.json() as Promise<AppConfig>;
}

export async function validateSourcePath(p: string): Promise<{ exists: boolean }> {
  const response = await fetch("/api/sources/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p }),
  });
  if (!response.ok) throw new Error(`Failed to validate path: ${response.status}`);
  return response.json() as Promise<{ exists: boolean }>;
}

export async function detectSources(): Promise<{ sources: SourceEntry[] }> {
  const response = await fetch("/api/sources/detect", { method: "POST" });
  if (!response.ok) throw new Error(`Failed to detect sources: ${response.status}`);
  return response.json() as Promise<{ sources: SourceEntry[] }>;
}

export type CollectSSEEvent =
  | { phase: "pricing"; detail: string }
  | { phase: "source-start"; source: string }
  | { phase: "source-progress"; source: string; detail: string; done?: number; total?: number }
  | { phase: "source-done"; source: string; count: number; ms: number }
  | { phase: "save"; detail: string }
  | { phase: "complete"; sessionCount: number; durationMs: number }
  | { phase: "error"; message: string };

export async function triggerCollect(
  reset: boolean,
  onEvent: (event: CollectSSEEvent) => void,
): Promise<void> {
  const response = await fetch("/api/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reset }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to start collect: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)) as CollectSSEEvent);
          } catch {
            // ignore malformed
          }
        }
      }
    }
  }
}
