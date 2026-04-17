import path from "node:path";

import { normalizeProjectPath } from "../core/project.js";
import type { Session } from "../core/types.js";
import type { MarsSessionMeta } from "./mars.js";

type SubAgentSource = "claude-code" | "codex" | "copilot-cli";

export function applyMarsMeta(session: Session, meta: MarsSessionMeta, subAgent: SubAgentSource): Session {
  const projectPath = meta.workspacePath ?? session.projectPath;
  const project = meta.workspacePath
    ? path.basename(normalizeProjectPath(meta.workspacePath)) || session.project
    : session.project;

  return {
    ...session,
    engine: engineLabel(subAgent),
    projectPath,
    project,
    orchestrator: {
      kind: "mars",
      taskId: meta.taskId,
      taskTitle: meta.taskTitle,
      taskStatus: meta.taskStatus,
      sessionName: meta.sessionName,
      marsSessionId: meta.marsSessionId,
    },
  };
}

function engineLabel(subAgent: SubAgentSource): string {
  if (subAgent === "claude-code") return "Mars + CC";
  if (subAgent === "codex") return "Mars + Codex";
  return "Mars + Copilot CLI";
}
