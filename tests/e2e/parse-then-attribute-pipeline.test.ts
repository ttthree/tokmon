import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectCommand } from "../../src/cli/commands/collect.js";
import { loadMachineData } from "../../src/core/data.js";
import { getMachineId } from "../../src/core/machine.js";
import { encodeClaudeProjectPath } from "../../src/core/source-resolver.js";
import { createEurekaClaudeSdkFixture, createEurekaCopilotFixture, createTestHome } from "../helpers/fixtures.js";
import { createMarsAgentConfigRoots, createMarsDbFixture } from "../helpers/mars-fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("parse-then-attribute pipeline", () => {
  it("keeps eureka matches deduped, retains Mars-root sessions, and stabilizes cost across runs", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const matchedWorkingDir = path.join(testHome, "work", "eureka-match");
    await createEurekaClaudeSdkFixture(testHome, {
      sessionId: "eureka-matched",
      sdkSessionId: "claude-sdk-match",
      workingDirectory: matchedWorkingDir,
    });
    await createEurekaCopilotFixture(testHome, {
      sessionId: "eureka-orphan",
      sdkSessionId: "copilot-sdk-orphan",
      includeSdkFile: false,
    });

    const roots = await createMarsAgentConfigRoots(testHome);
    const marsWorkspacePath = path.join(testHome, "work", "mars-workspace");
    await createMarsDbFixture({
      homeDir: testHome,
      workspaces: [{ idHex: "11111111111111111111111111111111", name: "ws", path: marsWorkspacePath }],
      tasks: [{ idHex: "22222222222222222222222222222222", workspaceIdHex: "11111111111111111111111111111111", title: "Mars Task" }],
      sessions: [{ idHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspaceIdHex: "11111111111111111111111111111111", taskIdHex: "22222222222222222222222222222222", agentType: "claude-code", agentSessionId: "mars-cc-1", name: "coder" }],
    });
    const marsProjectDir = path.join(roots.claude, "projects", encodeClaudeProjectPath(marsWorkspacePath) ?? "mars-workspace");
    await fs.mkdir(marsProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(marsProjectDir, "mars-cc-1.jsonl"),
      [
        JSON.stringify({ type: "assistant", timestamp: "2026-04-18T10:00:00.000Z", message: { model: "claude-sonnet-4", usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } } }),
        "",
      ].join("\n"),
      "utf8",
    );

    await collectCommand({ reset: true, silent: true });
    const first = await loadCurrentMachine();
    await collectCommand({ silent: true });
    const second = await loadCurrentMachine();

    expect(Object.keys(second.sessions)).toContain(`${second.machineId}:claude-code:eureka-matched`);
    expect(Object.keys(second.sessions)).not.toContain(`${second.machineId}:claude-code:claude-sdk-match`);
    expect(second.sessions[`${second.machineId}:claude-code:eureka-matched`]?.orchestrator).toEqual({ kind: "eureka" });
    expect(second.sessions[`${second.machineId}:copilot-cli:eureka-orphan`]?.tokenProvenance).toBe("telemetry");
    expect(second.sessions[`${second.machineId}:claude-code:mars-cc-1`]).toMatchObject({
      engine: "Mars + CC",
      projectPath: marsWorkspacePath,
      orchestrator: { kind: "mars", taskTitle: "Mars Task" },
    });
    expect(totalCost(second)).toBe(totalCost(first));
    expect(Object.keys(second.sessions)).toHaveLength(Object.keys(first.sessions).length);
  });
});

async function loadCurrentMachine() {
  const machineId = await getMachineId();
  return loadMachineData(machineId);
}

function totalCost(machineData: Awaited<ReturnType<typeof loadCurrentMachine>>): number {
  return Number(Object.values(machineData.sessions).reduce((sum, session) => sum + session.cost.total, 0).toFixed(12));
}
