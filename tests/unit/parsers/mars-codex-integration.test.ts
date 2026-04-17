import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { codexParser } from "../../../src/parsers/codex.js";
import { marsParser } from "../../../src/parsers/mars.js";
import { createTestHome } from "../../helpers/fixtures.js";
import { createMarsAgentConfigRoots, createMarsDbFixture } from "../../helpers/mars-fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("mars + codex integration", () => {
  it("tags matching Mars codex sessions", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const roots = await createMarsAgentConfigRoots(testHome);
    const workspacePath = path.join(testHome, "work", "mars-codex-ws");
    await createMarsDbFixture({
      homeDir: testHome,
      workspaces: [{ idHex: "11111111111111111111111111111111", name: "ws", path: workspacePath }],
      tasks: [{ idHex: "22222222222222222222222222222222", workspaceIdHex: "11111111111111111111111111111111", title: "Task C" }],
      sessions: [{ idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "codex", agentSessionId: "mars-cx-1", name: "reviewer" }],
    });

    const dbPath = path.join(roots.codex, "state_5.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, model_provider TEXT, created_at INTEGER, updated_at INTEGER, tokens_used INTEGER, title TEXT, archived INTEGER);
    `);
    db.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "mars-cx-1", workspacePath, "gpt-5.4", null, 1_700_000_000, 1_700_000_120, 0, "Mars Codex", 0,
    );
    db.close();

    const rolloutDir = path.join(roots.codex, "sessions", "2026", "04", "17");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-2026-04-17T10-00-00-mars-cx-1.jsonl"), [
      JSON.stringify({ timestamp: "2026-04-17T10:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "hello" } }),
      JSON.stringify({ timestamp: "2026-04-17T10:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 7 } } } }),
      "",
    ].join("\n"), "utf8");

    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    const result = await codexParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    const session = result.sessions.find((s) => s.id === "mars-cx-1");

    expect(session).toBeDefined();
    expect(session?.engine).toBe("Mars + Codex");
    expect(session?.orchestrator?.kind).toBe("mars");
    expect(session?.projectPath).toBe(workspacePath);
    expect(session?.tokens.input).toBe(80);
    expect(session?.tokens.cacheRead).toBe(20);
    expect(session?.tokens.output).toBe(7);
  });
});
