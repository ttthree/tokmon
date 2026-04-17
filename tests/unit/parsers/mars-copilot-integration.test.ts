import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { copilotCliParser } from "../../../src/parsers/copilot-cli.js";
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
  vi.restoreAllMocks();
});

describe("mars + copilot integration", () => {
  it("matches session_id, interaction_id, copilot_pid, and api_id fallback keys", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const roots = await createMarsAgentConfigRoots(testHome);
    await createMarsDbFixture({
      homeDir: testHome,
      sessions: [
        { idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agentType: "copilot-cli", agentSessionId: "session-key" },
        { idHex: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", agentType: "copilot-cli", agentSessionId: "interaction-key" },
        { idHex: "cccccccccccccccccccccccccccccccc", agentType: "copilot-cli", agentSessionId: "pid-key" },
        { idHex: "dddddddddddddddddddddddddddddddd", agentType: "copilot-cli", agentSessionId: "api-key" },
      ],
    });

    const logDir = path.join(roots.copilot, "logs");
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, "process-001.log"), [
      '2026-03-28T08:23:41.401Z [INFO] [Telemetry] cli.telemetry:',
      JSON.stringify({ kind: "assistant_usage", properties: { event_id: "a1", api_call_id: "api-a1", model: "claude", interaction_id: "interaction-a", copilot_pid: "pid-a" }, metrics: { input_tokens: 1, output_tokens: 1 }, session_id: "session-key" }),
      '2026-03-28T08:23:42.401Z [INFO] [Telemetry] cli.telemetry:',
      JSON.stringify({ kind: "assistant_usage", properties: { event_id: "a2", api_call_id: "api-a2", model: "claude", interaction_id: "interaction-key", copilot_pid: "pid-b" }, metrics: { input_tokens: 1, output_tokens: 1 } }),
      '2026-03-28T08:23:43.401Z [INFO] [Telemetry] cli.telemetry:',
      JSON.stringify({ kind: "assistant_usage", properties: { event_id: "a3", api_call_id: "api-a3", model: "claude", copilot_pid: "pid-key" }, metrics: { input_tokens: 1, output_tokens: 1 } }),
      '2026-03-28T08:23:44.401Z [INFO] [Telemetry] cli.telemetry:',
      JSON.stringify({ kind: "assistant_usage", properties: { event_id: "api-key", model: "claude" }, metrics: { input_tokens: 1, output_tokens: 1 } }),
      "",
    ].join("\n"), "utf8");

    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    const result = await copilotCliParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });

    expect(result.sessions.filter((s) => s.orchestrator?.kind === "mars")).toHaveLength(4);
    expect(result.sessions.find((s) => s.id === "session-key")?.engine).toBe("Mars + Copilot CLI");
    expect(result.sessions.find((s) => s.id === "interaction-key")?.orchestrator?.kind).toBe("mars");
    expect(result.sessions.find((s) => s.id === "pid-key")?.orchestrator?.kind).toBe("mars");
    expect(result.sessions.find((s) => s.id === "api-key")?.orchestrator?.kind).toBe("mars");
  });

  it("keeps unmatched sessions and logs debug message", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const roots = await createMarsAgentConfigRoots(testHome);
    await createMarsDbFixture({
      homeDir: testHome,
      sessions: [{ idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", agentType: "copilot-cli", agentSessionId: "other-key" }],
    });
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const logDir = path.join(roots.copilot, "logs");
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, "process-001.log"), [
      '2026-03-28T08:23:41.401Z [INFO] [Telemetry] cli.telemetry:',
      JSON.stringify({ kind: "assistant_usage", properties: { event_id: "evt-1", api_call_id: "api-evt-1", model: "claude" }, metrics: { input_tokens: 1, output_tokens: 1 } }),
      "",
    ].join("\n"), "utf8");

    await marsParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });
    const result = await copilotCliParser.parse({ machineId: "m1", existingCursor: createEmptyCursorState() });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].orchestrator).toBeUndefined();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("[mars] unmatched copilot session"));
  });
});
