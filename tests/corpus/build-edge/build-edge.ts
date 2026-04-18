import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { regenerateCorpusGoldens } from "../regenerate-golden.js";
import {
  EDGE_EPOCH,
  stampFiles,
  writeClaudeSession,
  writeClaudeSubagent,
  writeCodexRollout,
  writeCodexState,
  writeEurekaSession,
  writeMarsDatabase,
  writePricingSnapshot,
} from "./fixtures.js";

export async function buildEdgeCorpus(outDir: string): Promise<void> {
  const root = path.resolve(outDir);
  const homeDir = path.join(root, "home");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(homeDir, { recursive: true });
  await writePricingSnapshot(homeDir);

  await buildStandaloneClaude(homeDir);
  await buildEurekaCases(homeDir);
  await buildStandaloneCodex(homeDir);
  await buildMarsCases(homeDir);

  const fileMtimes = await stampFiles(homeDir);
  const totalBytes = await computeTotalBytes(root);
  const manifest = {
    id: path.basename(root),
    schemaVersion: 1,
    createdAt: new Date(EDGE_EPOCH).toISOString(),
    epoch: EDGE_EPOCH,
    seed: 0,
    sourceCounts: { "claude-code": 5, eureka: 4, codex: 1 },
    fileMtimes,
    totalBytes,
    sha256: await computeHash(root),
  };

  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(root, "README.md"), "# 2026-04-edge\n\nSynthetic edge corpus for attribution and aggregation tests.\n", "utf8");
  await regenerateCorpusGoldens(root);
}

async function buildStandaloneClaude(homeDir: string): Promise<void> {
  await writeClaudeSession({
    claudeRoot: path.join(homeDir, ".claude"),
    projectPath: "/Users/testuser/proj/plain",
    sessionId: "plain-cc-1",
    summary: "plain cc",
    firstPrompt: "inspect plain cc",
    createdAt: "2026-04-18T00:00:00.000Z",
    modifiedAt: "2026-04-18T00:02:00.000Z",
    assistantTurns: [{ model: "claude-sonnet-4-20250514", input: 100, output: 20, cacheCreation: 0, cacheRead: 50, timestamp: "2026-04-18T00:01:00.000Z" }],
  });
  await writeClaudeSession({
    claudeRoot: path.join(homeDir, ".claude"),
    projectPath: "/Users/testuser/proj/multi",
    sessionId: "multi-model-cc",
    summary: "multi model",
    firstPrompt: "use mixed models",
    createdAt: "2026-04-18T00:10:00.000Z",
    modifiedAt: "2026-04-18T00:14:00.000Z",
    assistantTurns: [
      { model: "claude-haiku-4-5-20251001", input: 10, output: 2, cacheCreation: 0, cacheRead: 3, timestamp: "2026-04-18T00:11:00.000Z" },
      { model: "claude-opus-4-6-1m", input: 30, output: 4, cacheCreation: 0, cacheRead: 5, timestamp: "2026-04-18T00:13:00.000Z" },
    ],
  });
  await writeClaudeSession({
    claudeRoot: path.join(homeDir, ".claude"),
    projectPath: "/Users/testuser/proj/broken",
    sessionId: "malformed-cc",
    summary: "malformed",
    firstPrompt: "skip bad lines",
    createdAt: "2026-04-18T00:20:00.000Z",
    modifiedAt: "2026-04-18T00:22:00.000Z",
    assistantTurns: [{ model: "claude-sonnet-4-20250514", input: 40, output: 5, cacheCreation: 0, cacheRead: 0, timestamp: "2026-04-18T00:21:00.000Z" }],
    malformedLine: "not-json",
  });
}

async function buildEurekaCases(homeDir: string): Promise<void> {
  const workspaceRoot = path.join(homeDir, ".craft-agent", "workspaces", "workspace-edge", "sessions");
  const craftClaude = path.join(homeDir, ".craft-agent", ".claude");

  await writeEurekaSession(path.join(workspaceRoot, "eureka-cc-normal"), { id: "eureka-cc-normal", name: "eureka cc", engine: "claude", model: "claude-sonnet-4-20250514", workingDirectory: "/Users/testuser/proj/eureka-cc", createdAt: "2026-04-18T01:00:00.000Z", lastUsedAt: "2026-04-18T01:03:00.000Z", sdkSessionId: "cc-sdk-normal", sdkCwd: "/Users/testuser/proj/eureka-cc" });
  await writeClaudeSession({ claudeRoot: craftClaude, projectPath: "/Users/testuser/proj/eureka-cc", sessionId: "cc-sdk-normal", summary: "linked cc", firstPrompt: "linked cc", createdAt: "2026-04-18T01:00:00.000Z", modifiedAt: "2026-04-18T01:03:00.000Z", assistantTurns: [{ model: "claude-sonnet-4-20250514", input: 120, output: 30, cacheCreation: 0, cacheRead: 40, timestamp: "2026-04-18T01:02:00.000Z" }] });

  await writeEurekaSession(path.join(workspaceRoot, "eureka-cc-orphan"), { id: "eureka-cc-orphan", name: "orphan", engine: "claude", model: "claude-sonnet-4-20250514", workingDirectory: "/Users/testuser/proj/eureka-orphan", createdAt: "2026-04-18T01:10:00.000Z", lastUsedAt: "2026-04-18T01:11:00.000Z", sdkSessionId: "cc-sdk-orphan", sdkCwd: "/Users/testuser/proj/eureka-orphan" });

  const codexSessionRoot = path.join(workspaceRoot, "eureka-codex");
  await writeEurekaSession(codexSessionRoot, { id: "eureka-codex", name: "eureka codex", engine: "codex", model: "gpt-5.4", workingDirectory: "/Users/testuser/proj/eureka-codex", createdAt: "2026-04-18T01:20:00.000Z", lastUsedAt: "2026-04-18T01:23:00.000Z", sdkSessionId: "019dedgecodex000000000000000001", sdkCwd: "/Users/testuser/proj/eureka-codex" });
  await writeCodexRollout(path.join(codexSessionRoot, ".codex-home", "sessions", "2026", "04", "18", "rollout-2026-04-18T01-21-00-019dedgecodex000000000000000001.jsonl"), [
    { timestamp: "2026-04-18T01:20:30.000Z", type: "turn_context", payload: { model: "gpt-5.4" } },
    { timestamp: "2026-04-18T01:21:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 20 } } } },
  ]);

  await writeEurekaSession(path.join(workspaceRoot, "eureka-subagent"), { id: "eureka-subagent", name: "eureka sub", engine: "claude", model: "claude-sonnet-4-20250514", workingDirectory: "/Users/testuser/proj/subagent", createdAt: "2026-04-18T01:30:00.000Z", lastUsedAt: "2026-04-18T01:35:00.000Z", sdkSessionId: "cc-sdk-subagent", sdkCwd: "/Users/testuser/proj/subagent" });
  await writeClaudeSession({ claudeRoot: craftClaude, projectPath: "/Users/testuser/proj/subagent", sessionId: "cc-sdk-subagent", summary: "claimed parent", firstPrompt: "subagent parent", createdAt: "2026-04-18T01:30:00.000Z", modifiedAt: "2026-04-18T01:35:00.000Z", assistantTurns: [{ model: "claude-sonnet-4-20250514", input: 50, output: 10, cacheCreation: 0, cacheRead: 10, timestamp: "2026-04-18T01:32:00.000Z" }] });
  await writeClaudeSubagent(craftClaude, "/Users/testuser/proj/subagent", "cc-sdk-subagent", "sub1.jsonl", "child task", { model: "claude-haiku-4-5-20251001", input: 7, output: 3, cacheCreation: 0, cacheRead: 1, timestamp: "2026-04-18T01:33:00.000Z" });
}

async function buildStandaloneCodex(homeDir: string): Promise<void> {
  await writeCodexState(path.join(homeDir, ".codex"), [{ id: "codex-no-usage", cwd: "/Users/testuser/proj/codex-empty", model: "gpt-4.1", provider: null, createdAt: "2026-04-18T02:00:00.000Z", updatedAt: "2026-04-18T02:04:00.000Z", title: "telemetry only" }]);
  await writeCodexRollout(path.join(homeDir, ".codex", "sessions", "2026", "04", "18", "rollout-2026-04-18T02-00-00-codex-no-usage.jsonl"), [
    { timestamp: "2026-04-18T02:00:10.000Z", type: "event_msg", payload: { type: "user_message", message: "no usage event" } },
    { timestamp: "2026-04-18T02:00:20.000Z", type: "event_msg", payload: { type: "agent_message", message: "still valid" } },
  ]);
}

async function buildMarsCases(homeDir: string): Promise<void> {
  const appDirs = [
    path.join(homeDir, "Library", "Application Support", "com.marsiwe.app"),
    path.join(homeDir, ".config", "com.marsiwe.app"),
    path.join(homeDir, "AppData", "Roaming", "com.marsiwe.app"),
  ];
  for (const appDir of appDirs) {
    await writeMarsDatabase(appDir, { taskId: "11111111111111111111111111111111", taskTitle: "Edge Mars Task", workspaceId: "22222222222222222222222222222222", workspaceName: "edge-workspace", workspacePath: "/Users/testuser/work/mars-workspace", sessions: [
      { id: "33333333333333333333333333333333", agentType: "claude-code", agentSessionId: "mars-claude-1", name: "mars session 1", updatedAt: "2026-04-18T03:02:00.000Z" },
      { id: "44444444444444444444444444444444", agentType: "claude-code", agentSessionId: "mars-claude-2", name: "mars session 2", updatedAt: "2026-04-18T03:04:00.000Z" },
    ] });
    const claudeRoot = path.join(appDir, "agent-configs", "claude");
    await writeClaudeSession({ claudeRoot, projectPath: "/Users/testuser/work/mars-workspace", sessionId: "mars-claude-1", summary: "mars one", firstPrompt: "mars task one", createdAt: "2026-04-18T03:00:00.000Z", modifiedAt: "2026-04-18T03:02:00.000Z", assistantTurns: [{ model: "claude-sonnet-4-20250514", input: 70, output: 9, cacheCreation: 0, cacheRead: 15, timestamp: "2026-04-18T03:01:00.000Z" }] });
    await writeClaudeSession({ claudeRoot, projectPath: "/Users/testuser/work/mars-workspace", sessionId: "mars-claude-2", summary: "mars two", firstPrompt: "mars task two", createdAt: "2026-04-18T03:03:00.000Z", modifiedAt: "2026-04-18T03:05:00.000Z", assistantTurns: [{ model: "claude-opus-4-6-1m", input: 90, output: 11, cacheCreation: 0, cacheRead: 20, timestamp: "2026-04-18T03:04:00.000Z" }] });
  }
}

async function computeTotalBytes(root: string): Promise<number> {
  const files = await fs.readdir(root, { recursive: true, withFileTypes: true } as { recursive: true; withFileTypes: true });
  let total = 0;
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    total += (await fs.stat(filePath)).size;
  }
  return total;
}

async function computeHash(root: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const files = await fs.readdir(root, { recursive: true, withFileTypes: true } as { recursive: true; withFileTypes: true });
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    hash.update(path.relative(root, filePath));
    hash.update(await fs.readFile(filePath));
  }
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex === -1 || !process.argv[outIndex + 1]) {
    throw new Error("Usage: tsx tests/corpus/build-edge/build-edge.ts --out <dir>");
  }
  await buildEdgeCorpus(process.argv[outIndex + 1]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
