import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverMarsTasks, selectDiscovered, truncateJsonl } from "../../../src/cli/commands/corpus/sample.js";
import { createTestHome } from "../../helpers/fixtures.js";
import { createMarsDbFixture, marsAppDirForTest } from "../../helpers/mars-fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
});

describe("corpus sample helpers", () => {
  it("selectDiscovered is deterministic for same seed", () => {
    const input = [
      { sessionId: "a", sourceCategory: "codex" as const, primaryFile: "a", auxFiles: [] },
      { sessionId: "b", sourceCategory: "codex" as const, primaryFile: "b", auxFiles: [] },
      { sessionId: "c", sourceCategory: "codex" as const, primaryFile: "c", auxFiles: [] },
    ];
    const left = selectDiscovered(input, 42, 2).map((x) => x.sessionId);
    const right = selectDiscovered(input, 42, 2).map((x) => x.sessionId);
    expect(left).toEqual(right);
  });

  it("discoverMarsTasks groups all sessions sharing task_id", async () => {
    testHome = await createTestHome();
    await createMarsDbFixture({
      homeDir: testHome,
      tasks: [
        { idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "task-1" },
        { idHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", title: "task-2" },
      ],
      sessions: [
        { idHex: "11111111111111111111111111111111", taskIdHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agentType: "codex", agentSessionId: "s1" },
        { idHex: "22222222222222222222222222222222", taskIdHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agentType: "claude-code", agentSessionId: "s2" },
        { idHex: "33333333333333333333333333333333", taskIdHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agentType: "codex", agentSessionId: "s3" },
      ],
    });
    const appDir = marsAppDirForTest(testHome, "com.marsiwe.app");
    const groups = await discoverMarsTasks([{ path: appDir }]);
    const task1 = groups.find((g) => g.taskId === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(task1?.agentSessionIds.sort()).toEqual(["s1", "s2"]);
  });

  it("codex truncation keeps total_token_usage marker", () => {
    const filler = "x".repeat(1024);
    const raw = [
      ...Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: "event_msg", payload: { type: "noop", i, filler } })),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1 } } } }),
    ].join("\n");

    const lines = truncateJsonl(raw, 8 * 1024, true);
    expect(lines.some((l) => l.includes("total_token_usage"))).toBe(true);
  });
});
