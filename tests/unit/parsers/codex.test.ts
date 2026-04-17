import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createCodexFixture, createTestHome } from "../../helpers/fixtures.js";
import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { codexParser } from "../../../src/parsers/codex.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("codex parser", () => {
  it("reads sessions and tool counts from sqlite", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createCodexFixture(testHome);
    const result = await codexParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].toolCallCount).toBe(0);
    expect(result.sessions[0].tokens.input).toBe(0);
    expect(result.sessions[0].tokens.output).toBe(0);
  });

  it("derives turns, tools, duration, and firstPrompt from rollout JSONL", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await createCodexFixture(testHome, { includeRollout: true });
    const result = await codexParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.turns).toBe(1);
    expect(session.messageCount).toBe(2);
    expect(session.toolCallCount).toBe(1); // duplicate call_id deduped
    expect(session.toolBreakdown.exec_command).toBe(1);
    expect(session.firstPrompt).toBe("Review the auth flow and list issues.");
    // Duration from rollout event span (~11s), not from SQLite threads (1200s)
    expect(session.durationSeconds).toBeLessThan(60);
    // Tokens from rollout total_token_usage
    expect(session.tokens.output).toBe(80);
    expect(session.tokens.cacheRead).toBe(400);
    expect(session.tokens.input).toBe(800); // 1200 - 400
  });
});
