import { createEmptyCursorState } from "./cursor.js";
import type { MachineData, PrivacyConfig, Session } from "./types.js";

export function redactSessionForSync(session: Session, config: PrivacyConfig): Session {
  return {
    ...session,
    projectPath: config.sync.includeProjectPath ? session.projectPath : "[redacted]",
    project: config.sync.includeProjectName ? session.project : "[redacted]",
    summary: config.sync.includeSummary ? session.summary : undefined,
    firstPrompt: config.sync.includeFirstPrompt ? session.firstPrompt : undefined,
  };
}

export function redactForSync(machineData: MachineData, config: PrivacyConfig): MachineData {
  const sessions = Object.fromEntries(
    Object.entries(machineData.sessions).map(([key, session]) => [key, redactSessionForSync(session, config)]),
  );

  return {
    ...machineData,
    sessions,
    _cursor: createEmptyCursorState(),
  };
}
