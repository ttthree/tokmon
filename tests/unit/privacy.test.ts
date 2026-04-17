import { describe, expect, it } from "vitest";

import { redactSessionForSync } from "../../src/core/privacy.js";
import { createEmptyCursorState } from "../../src/core/cursor.js";
import { redactForSync } from "../../src/core/privacy.js";
import type { Session } from "../../src/core/types.js";

const session: Session = {
  id: "session-1",
  machineId: "machine-1",
  source: "claude-code",
  projectPath: "/Users/secret/project",
  project: "project",
  summary: "Fixed auth bug",
  firstPrompt: "Help me fix auth",
  model: "claude-sonnet-4",
  createdAt: "2026-04-08T00:00:00.000Z",
  modifiedAt: "2026-04-08T00:05:00.000Z",
  durationSeconds: 300,
  turns: 1,
  messageCount: 2,
  toolCallCount: 0,
  tokens: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
  cost: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
  toolBreakdown: {},
  orchestrator: { kind: "mars", taskTitle: "Secret Task", sessionName: "coder", marsSessionId: "abc" },
};

describe("privacy", () => {
  it("redacts sensitive fields by default", () => {
    const redacted = redactSessionForSync(session, {
      sync: { includeSummary: false, includeFirstPrompt: false, includeProjectPath: false, includeProjectName: false, includeOrchestratorMetadata: false },
    });
    expect(redacted.projectPath).toBe("[redacted]");
    expect(redacted.project).toBe("[redacted]");
    expect(redacted.summary).toBeUndefined();
    expect(redacted.firstPrompt).toBeUndefined();
    expect(redacted.orchestrator).toEqual({ kind: "mars" });
  });

  it("retains orchestrator metadata when enabled", () => {
    const redacted = redactSessionForSync(session, {
      sync: { includeSummary: false, includeFirstPrompt: false, includeProjectPath: false, includeProjectName: false, includeOrchestratorMetadata: true },
    });
    expect(redacted.orchestrator?.taskTitle).toBe("Secret Task");
    expect(redacted.orchestrator?.sessionName).toBe("coder");
  });

  it("removes cursor details from synced machine data", () => {
    const machineData = {
      machineId: "machine-1",
      hostname: "host",
      os: "darwin-arm64",
      lastUpdatedAt: "2026-04-08T00:00:00.000Z",
      sessions: { "machine-1:claude-code:session-1": session },
      _cursor: {
        ...createEmptyCursorState(),
        files: {
          "/Users/secret/project/session.jsonl": {
            path: "/Users/secret/project/session.jsonl",
            inode: 1,
            size: 10,
            mtimeMs: 5,
            byteOffset: 10,
            processedAt: "2026-04-08T00:00:00.000Z",
          },
        },
      },
    };

    const redacted = redactForSync(machineData, {
      sync: { includeSummary: false, includeFirstPrompt: false, includeProjectPath: false, includeProjectName: false, includeOrchestratorMetadata: false },
    });

    expect(redacted._cursor.files).toEqual({});
  });
});
