import type { DataResponse } from "../core/types.js";
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
