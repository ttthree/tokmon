import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { collectCommand } from "../../src/cli/commands/collect.js";
import { loadMachineData } from "../../src/core/data.js";
import { getMachineId } from "../../src/core/machine.js";
import { createTestHome } from "../helpers/fixtures.js";
import { createMarsAgentConfigRoots, createMarsDbFixture } from "../helpers/mars-fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("mars e2e", () => {
  it("collects and tags Mars sessions from isolated roots without double counting", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    const roots = await createMarsAgentConfigRoots(testHome);
    const workspacePath = path.join(testHome, "work", "mars-e2e");

    await createMarsDbFixture({
      homeDir: testHome,
      workspaces: [{ idHex: "11111111111111111111111111111111", name: "ws", path: workspacePath }],
      tasks: [{ idHex: "22222222222222222222222222222222", workspaceIdHex: "11111111111111111111111111111111", title: "Task E2E", status: "inprogress" }],
      sessions: [
        { idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "claude-code", agentSessionId: "cc-1", name: "coder" },
        { idHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "claude-code", agentSessionId: "cc-2", name: "reviewer" },
        { idHex: "cccccccccccccccccccccccccccccccc", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "codex", agentSessionId: "cx-1", name: "codex" },
        { idHex: "dddddddddddddddddddddddddddddddd", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "copilot-cli", agentSessionId: "cp-1", name: "copilot" },
      ],
    });

    const claudeProject = path.join(roots.claude, "projects", "-tmp-e2e");
    await fs.mkdir(claudeProject, { recursive: true });
    await fs.writeFile(path.join(claudeProject, "cc-1.jsonl"), JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 1 } } }) + "\n", "utf8");
    await fs.writeFile(path.join(claudeProject, "cc-2.jsonl"), JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4", usage: { input_tokens: 8, output_tokens: 2 } } }) + "\n", "utf8");

    const codexDb = new Database(path.join(roots.codex, "state_5.sqlite"));
    codexDb.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, model_provider TEXT, created_at INTEGER, updated_at INTEGER, tokens_used INTEGER, title TEXT, archived INTEGER);`);
    codexDb.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("cx-1", workspacePath, "gpt-5.4", null, 1_700_000_000, 1_700_000_100, 0, "codex", 0);
    codexDb.close();
    const rolloutDir = path.join(roots.codex, "sessions", "2026", "04", "17");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-2026-04-17T10-00-00-cx-1.jsonl"), JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 } } } }) + "\n", "utf8");

    const copilotLogDir = path.join(roots.copilot, "logs");
    await fs.mkdir(copilotLogDir, { recursive: true });
    await fs.writeFile(path.join(copilotLogDir, "process-001.log"), JSON.stringify({ kind: "assistant_usage", session_id: "cp-1", properties: { event_id: "evt-1", model: "claude" }, metrics: { input_tokens: 6, output_tokens: 3 } }) + "\n", "utf8");

    await collectCommand({ reset: true, silent: true });
    await collectCommand({ silent: true });

    const machineId = await getMachineId();
    const machine = await loadMachineData(machineId);
    const marsSessions = Object.values(machine.sessions).filter((s) => s.orchestrator?.kind === "mars");

    expect(marsSessions).toHaveLength(4);
    expect(new Set(marsSessions.map((s) => s.id))).toEqual(new Set(["cc-1", "cc-2", "cx-1", "cp-1"]));
  }, 20000);
});
