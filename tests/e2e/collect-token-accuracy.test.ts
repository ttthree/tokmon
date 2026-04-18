import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectCommand } from "../../src/cli/commands/collect.js";
import { DEFAULT_CONFIG, saveConfig } from "../../src/core/config.js";
import { loadMachineData } from "../../src/core/data.js";
import { getMachineId } from "../../src/core/machine.js";
import { encodeClaudeProjectPath } from "../../src/core/source-resolver.js";
import { createEurekaClaudeSdkFixture, createEurekaCopilotFixture, createTestHome } from "../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("collect token accuracy", () => {
  it("collects exact token totals and provenance across the bug scenarios", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const fixturesRoot = path.join(testHome, "tests", "fixtures", "sessions");
    const ccLargeRoot = path.join(fixturesRoot, "cc-large");
    const eurekaClaudeRoot = path.join(fixturesRoot, "eureka-anthropic");
    const eurekaCopilotShutdownRoot = path.join(fixturesRoot, "eureka-copilot-sdk-with-shutdown");
    const eurekaCopilotNoShutdownRoot = path.join(fixturesRoot, "eureka-copilot-sdk-no-shutdown");

    await createLargeClaudeFixture(ccLargeRoot);
    await createEurekaClaudeSdkFixture(eurekaClaudeRoot, { sessionId: "260418-eureka-claude" });
    await createEurekaCopilotFixture(eurekaCopilotShutdownRoot, { sessionId: "260418-copilot-shutdown" });
    await createEurekaCopilotFixture(eurekaCopilotNoShutdownRoot, {
      sessionId: "260418-copilot-no-shutdown",
      eventLines: [
        JSON.stringify({ type: "session.start", data: {} }),
        JSON.stringify({ type: "assistant.message", data: { usage: { inputTokens: 40, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 1 } } }),
        JSON.stringify({ type: "assistant.turn_end", data: { usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 } } }),
        JSON.stringify({ type: "tool.result", data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } } }),
        "",
      ],
    });

    await fs.mkdir(path.join(testHome, ".craft-agent"), { recursive: true });
    await fs.cp(
      path.join(eurekaClaudeRoot, ".craft-agent", ".claude"),
      path.join(testHome, ".craft-agent", ".claude"),
      { recursive: true },
    );

    await saveConfig({
      ...DEFAULT_CONFIG,
      pricing: { autoUpdate: false, updateIntervalHours: DEFAULT_CONFIG.pricing.updateIntervalHours },
      sources: [
        { id: "claude-large", type: "claude-code", path: path.join(ccLargeRoot, ".claude"), enabled: true, autoDetected: false },
        { id: "eureka-claude", type: "eureka", path: path.join(eurekaClaudeRoot, ".craft-agent", "workspaces"), enabled: true, autoDetected: false },
        { id: "eureka-copilot-shutdown", type: "eureka", path: path.join(eurekaCopilotShutdownRoot, ".craft-agent", "workspaces"), enabled: true, autoDetected: false },
        { id: "eureka-copilot-events", type: "eureka", path: path.join(eurekaCopilotNoShutdownRoot, ".craft-agent", "workspaces"), enabled: true, autoDetected: false },
      ],
    });

    await collectCommand({ reset: true, silent: true });

    const machineId = await getMachineId();
    const machine = await loadMachineData(machineId);
    const expected = JSON.parse(await fs.readFile(path.join(process.cwd(), "tests", "fixtures", "sessions", "expected.json"), "utf8")) as Record<string, unknown>;
    const actual = Object.fromEntries(
      Object.values(machine.sessions)
        .filter((session) => session.id in expected)
        .map((session) => [session.id, { tokens: session.tokens, tokenProvenance: session.tokenProvenance }]),
    );

    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    expect(actual).toEqual(expected);
  }, 30000);
});

async function createLargeClaudeFixture(root: string): Promise<void> {
  const projectPath = path.join(root, "work", "cc-large-project");
  const projectDir = path.join(root, ".claude", "projects", encodeClaudeProjectPath(projectPath) ?? "cc-large-project");
  const sessionId = "cc-large-session";
  const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
  const repeatCount = 18000;

  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      entries: [{
        sessionId,
        fullPath: `${sessionId}.jsonl`,
        fileMtime: Date.now(),
        firstPrompt: "Audit the large session",
        summary: "Large CC session",
        messageCount: repeatCount + 1,
        created: "2026-04-18T08:00:00.000Z",
        modified: "2026-04-18T08:30:00.000Z",
        projectPath,
        isSidechain: false,
      }],
    }, null, 2),
    "utf8",
  );

  const filler = "x".repeat(260);
  const userLine = `${JSON.stringify({ type: "user", timestamp: "2026-04-18T08:00:00.000Z", sessionId, message: { role: "user", content: [{ type: "text", text: "Audit the large session" }] } })}\n`;
  const assistantLine = `${JSON.stringify({ type: "assistant", timestamp: "2026-04-18T08:00:01.000Z", sessionId, message: { role: "assistant", model: "claude-sonnet-4-20250514", usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }, content: [{ type: "text", text: filler }] } })}\n`;

  await fs.writeFile(sessionFile, userLine, "utf8");
  const chunk = assistantLine.repeat(500);
  for (let index = 0; index < repeatCount / 500; index += 1) {
    await fs.appendFile(sessionFile, chunk, "utf8");
  }
}
