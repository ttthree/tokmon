import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createEurekaCodexFixture, createTestHome } from "../../helpers/fixtures.js";
import { createEmptyCursorState } from "../../../src/core/cursor.js";
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
});
