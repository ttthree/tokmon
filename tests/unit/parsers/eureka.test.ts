import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createEurekaClaudeSdkFixture, createEurekaCodexFixture, createTestHome } from "../../helpers/fixtures.js";
import { createEmptyCursorState, mergeCursorState } from "../../../src/core/cursor.js";
import { claudeCodeParser } from "../../../src/parsers/claude-code.js";
import { claimedCcSessionIds, eurekaParser } from "../../../src/parsers/eureka.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("eureka parser", () => {
  it("attributes Codex token deltas by turn_context model", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCodexFixture(testHome);

    const result = await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.source).toBe("codex");
    expect(session.orchestrator).toEqual({ kind: "eureka" });
    expect(session.model).toBe("gpt-5.4");
    expect(session.tokens).toEqual({ input: 1300, output: 90, cacheCreation: 0, cacheRead: 300 });
    expect(session.modelUsage).toEqual({
      "gpt-5.4": { input: 800, output: 50, cacheCreation: 0, cacheRead: 200 },
      "gpt-5.4-mini": { input: 500, output: 40, cacheCreation: 0, cacheRead: 100 },
    });
  });

  it("falls back to header model when rollout lacks turn_context model", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    await createEurekaCodexFixture(testHome, {
      sessionId: "260414-gentle-amber",
      sdkSessionId: "019d9011-1c69-7f92-a709-8ce156d211e1",
      headerModel: "gpt-5.4",
      rolloutLines: [
        JSON.stringify({
          timestamp: "2026-04-14T02:45:56.049Z",
          type: "session_meta",
          payload: { id: "019d9011-1c69-7f92-a709-8ce156d211e1", model_provider: "openai" },
        }),
        JSON.stringify({
          timestamp: "2026-04-14T02:46:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 25 },
              last_token_usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 25 },
            },
          },
        }),
        "",
      ],
    });

    const result = await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.source).toBe("codex");
    expect(session.orchestrator).toEqual({ kind: "eureka" });
    expect(session.model).toBe("gpt-5.4");
    expect(session.modelUsage).toEqual({
      "gpt-5.4": { input: 500, output: 25, cacheCreation: 0, cacheRead: 400 },
    });
  });

  it("clears claimed session ids at the start of parse", async () => {
    claimedCcSessionIds.add("stale-id");
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;
    await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(claimedCcSessionIds.has("stale-id")).toBe(false);
  });

  it("re-registers claimed SDK session id when cursor hits on incremental run", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const sdkSessionId = "claude-sdk-session-1";
    await createEurekaClaudeSdkFixture(testHome, { sdkSessionId });

    // Cold-start: parse populates claimedCcSessionIds and emits cursor updates
    // including claimedSdkSessionId.
    const first = await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(claimedCcSessionIds.has(sdkSessionId)).toBe(true);
    expect(first.sessions).toHaveLength(1);

    const persistedCursor = mergeCursorState(createEmptyCursorState(), first.cursorUpdates);
    const persistedEntries = Object.values(persistedCursor.files);
    expect(persistedEntries.some((entry) => entry.claimedSdkSessionId === sdkSessionId)).toBe(true);

    // Simulate fresh process: claimedCcSessionIds starts empty.
    claimedCcSessionIds.clear();

    // Incremental run: cursor hits (no file changes) but the fix re-registers
    // claimedSdkSessionId so the CC parser still skips the SDK file.
    await eurekaParser.parse({ machineId: "machine-1", existingCursor: persistedCursor });
    expect(claimedCcSessionIds.has(sdkSessionId)).toBe(true);

    const ccResult = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(ccResult.sessions.some((s) => s.id === sdkSessionId)).toBe(false);
  });

  it("re-parses when previous run produced incomplete tokens (CC SDK file appeared late)", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const sdkSessionId = "claude-sdk-session-late";
    // First parse: no SDK file yet → tokens 0, provenance "telemetry-incomplete".
    await createEurekaClaudeSdkFixture(testHome, { sdkSessionId, includeSdkFile: false });

    const first = await eurekaParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0].tokenProvenance).toBe("telemetry-incomplete");
    expect(first.sessions[0].tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

    const persistedCursor = mergeCursorState(createEmptyCursorState(), first.cursorUpdates);
    const cursorEntry = Object.values(persistedCursor.files).find((e) => e.claimedSdkSessionId === sdkSessionId);
    expect(cursorEntry?.lastProvenance).toBe("telemetry-incomplete");
    expect(cursorEntry?.claimedSdkCwd).toBeTruthy();

    // SDK file shows up after the fact (without changing telemetry/session.jsonl).
    await createEurekaClaudeSdkFixture(testHome, { sdkSessionId });

    // Second parse: cursor would normally hit, but lastProvenance="telemetry-incomplete" forces a retry.
    claimedCcSessionIds.clear();
    const second = await eurekaParser.parse({ machineId: "machine-1", existingCursor: persistedCursor });
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].tokenProvenance).toBe("sdk-cc-jsonl");
    expect(second.sessions[0].tokens.input).toBeGreaterThan(0);
  });
});
