import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { encodeClaudeProjectPath } from "../../src/core/source-resolver.js";
import type { PricingSnapshot } from "../../src/core/types.js";

interface ClaudeFixtureOptions {
  ageDays?: number;
  sessionId?: string;
  projectName?: string;
  projectPath?: string;
  summary?: string;
  firstPrompt?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  durationMinutes?: number;
  transcript?: "basic" | "rich" | "malformed";
}

export async function createTestHome(): Promise<string> {
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-test-"));
  await fs.mkdir(path.join(testHome, ".tokmon", "pricing"), { recursive: true });
  await fs.writeFile(
    path.join(testHome, ".tokmon", "pricing", "2026-01-01T00:00:00.000Z.json"),
    JSON.stringify(defaultPricingSnapshot(), null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(testHome, ".tokmon", "pricing", "latest.json"),
    JSON.stringify(defaultPricingSnapshot(), null, 2),
    "utf8",
  );
  return testHome;
}

export async function createClaudeFixture(testHome: string, ageDaysOrOptions: number | ClaudeFixtureOptions = 3): Promise<void> {
  const options = typeof ageDaysOrOptions === "number" ? { ageDays: ageDaysOrOptions } : ageDaysOrOptions;
  const ageDays = options.ageDays ?? 3;
  const sessionId = options.sessionId ?? "fixture-session-1";
  const projectName = options.projectName ?? "sample-project";
  const projectPath = options.projectPath ?? path.join(testHome, "work", projectName);
  const summary = options.summary ?? "Fixed auth bug";
  const firstPrompt = options.firstPrompt ?? "Investigate a bug";
  const model = options.model ?? "claude-sonnet-4-20250514";
  const inputTokens = options.inputTokens ?? 1000;
  const outputTokens = options.outputTokens ?? 500;
  const cacheCreationTokens = options.cacheCreationTokens ?? 200;
  const cacheReadTokens = options.cacheReadTokens ?? 10000;
  const durationMinutes = options.durationMinutes ?? 15;
  const transcript = options.transcript ?? "basic";

  const projectDir = path.join(testHome, ".claude", "projects", encodeClaudeProjectPath(projectPath) ?? projectName);
  await fs.mkdir(projectDir, { recursive: true });
  const created = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  const modified = new Date(created.getTime() + durationMinutes * 60 * 1000);
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      entries: [
        {
          sessionId,
          fullPath: `${sessionId}.jsonl`,
          fileMtime: modified.getTime(),
          firstPrompt,
          summary,
          messageCount: 2,
          created: created.toISOString(),
          modified: modified.toISOString(),
          gitBranch: "main",
          projectPath,
          isSidechain: false,
        },
      ],
    }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    buildClaudeTranscript({ sessionId, firstPrompt, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, transcript }),
    "utf8",
  );
}

export async function createCopilotFixture(testHome: string, fileName = "process-001.log"): Promise<void> {
  const logDir = path.join(testHome, ".copilot", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, fileName),
    [
      '2026-03-28T08:23:41.401Z [INFO] [Telemetry] cli.telemetry:',
      JSON.stringify({
        kind: "assistant_usage",
        properties: {
          event_id: "event-1",
          api_call_id: "api-1",
          model: "claude-opus-4.6",
          interaction_id: "interaction-1",
          copilot_pid: "pid-1",
        },
        metrics: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          duration: 2000,
        },
      }),
      '2026-03-28T08:23:42.401Z [INFO] [Telemetry] cli.model_call:',
      JSON.stringify({
        api_id: "api-2",
        model: "claude-opus-4.6",
        interaction_id: "interaction-1",
        prompt_tokens_count: 75,
        completion_tokens_count: 10,
        duration: 1000,
      }),
      "",
    ].join("\n"),
    "utf8",
  );
}

export async function createCodexFixture(testHome: string, options?: { includeRollout?: boolean }): Promise<void> {
  const codexDir = path.join(testHome, ".codex");
  await fs.mkdir(codexDir, { recursive: true });
  const dbPath = path.join(codexDir, "state_1.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      model TEXT,
      model_provider TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      tokens_used INTEGER,
      title TEXT,
      archived INTEGER
    );
  `);
  db.prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "codex-session-1",
    path.join(testHome, "work", "codex-project"),
    "gpt-4.1",
    null,
    Math.floor(new Date("2026-04-05T10:00:00.000Z").getTime() / 1000),
    Math.floor(new Date("2026-04-05T10:20:00.000Z").getTime() / 1000),
    750,
    "Session title",
    0,
  );
  db.close();

  if (options?.includeRollout) {
    const rolloutDir = path.join(codexDir, "sessions", "2026", "04", "05");
    await fs.mkdir(rolloutDir, { recursive: true });
    const lines = [
      JSON.stringify({ timestamp: "2026-04-05T10:00:10.000Z", type: "event_msg", payload: { type: "user_message", message: "Review the auth flow and list issues." } }),
      JSON.stringify({ timestamp: "2026-04-05T10:00:12.000Z", type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } }),
      JSON.stringify({ timestamp: "2026-04-05T10:00:13.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "README.md\nsrc/" } }),
      // Duplicate function_call entry that codex sometimes re-emits — should be de-duped.
      JSON.stringify({ timestamp: "2026-04-05T10:00:14.000Z", type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" } }),
      JSON.stringify({ timestamp: "2026-04-05T10:00:20.000Z", type: "event_msg", payload: { type: "agent_message", message: "Done." } }),
      JSON.stringify({
        timestamp: "2026-04-05T10:00:21.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 1300 } },
        },
      }),
      "",
    ];
    await fs.writeFile(
      path.join(rolloutDir, "rollout-2026-04-05T10-00-10-codex-session-1.jsonl"),
      lines.join("\n"),
      "utf8",
    );
  }
}

export async function createEurekaCodexFixture(testHome: string, options?: {
  sessionId?: string;
  sdkSessionId?: string;
  headerModel?: string;
  workingDirectory?: string;
  rolloutLines?: string[];
}): Promise<void> {
  const sessionId = options?.sessionId ?? "260412-ready-puma";
  const sdkSessionId = options?.sdkSessionId ?? "019d7f4b-1c69-7f92-a709-8ce156d211e1";
  const headerModel = options?.headerModel ?? "gpt-5.4";
  const workingDirectory = options?.workingDirectory ?? path.join(testHome, "work", "openharness");
  const sessionDir = path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", sessionId);
  const rolloutDir = path.join(sessionDir, ".codex-home", "sessions", "2026", "04", "12");
  await fs.mkdir(rolloutDir, { recursive: true });

  await fs.writeFile(
    path.join(sessionDir, "session.jsonl"),
    [
      JSON.stringify({
        id: sessionId,
        createdAt: Date.parse("2026-04-12T01:25:22.163Z"),
        lastUsedAt: Date.parse("2026-04-12T01:50:11.784Z"),
        name: "OpenHarness task",
        engine: "codex",
        model: headerModel,
        runtimeProvider: "codex_agent_sdk",
        type: "task",
        messageCount: 4,
        userMessageCount: 2,
        workingDirectory,
        sdkSessionId,
        sdkCwd: workingDirectory,
        tokenUsage: {
          inputTokens: 999,
          outputTokens: 111,
          totalTokens: 1110,
          costUsd: 0,
          cacheReadTokens: 222,
          cacheCreationTokens: 0,
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const rolloutLines = options?.rolloutLines ?? [
    JSON.stringify({
      timestamp: "2026-04-12T01:25:22.363Z",
      type: "session_meta",
      payload: {
        id: sdkSessionId,
        cwd: workingDirectory,
        originator: "codex_sdk_ts",
        cli_version: "0.107.0",
        source: "exec",
        model_provider: "openai",
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-12T01:25:22.400Z",
      type: "turn_context",
      payload: { turn_id: "turn-1", cwd: workingDirectory, model: "gpt-5.4" },
    }),
    JSON.stringify({
      timestamp: "2026-04-12T01:25:23.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 },
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 },
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-12T01:30:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-2", cwd: workingDirectory, model: "gpt-5.4-mini" },
    }),
    JSON.stringify({
      timestamp: "2026-04-12T01:30:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 1600, cached_input_tokens: 300, output_tokens: 90 },
          last_token_usage: { input_tokens: 600, cached_input_tokens: 100, output_tokens: 40 },
        },
      },
    }),
    "",
  ];

  await fs.writeFile(
    path.join(rolloutDir, `rollout-2026-04-12T09-25-22-${sdkSessionId}.jsonl`),
    rolloutLines.join("\n"),
    "utf8",
  );
}

export async function createClaudeCraftAgentsSubagentFixture(testHome: string, options?: {
  parentSessionId?: string;
  subagentId?: string;
  cwd?: string;
  encodedProjectDirName?: string;
  firstPrompt?: string;
}): Promise<void> {
  const parentSessionId = options?.parentSessionId ?? "parent-craft-session";
  const subagentId = options?.subagentId ?? "agent-a0e2e7f";
  const cwd = options?.cwd ?? `${testHome}/work/craft-agents`;
  const encodedProjectDirName = options?.encodedProjectDirName ?? "-Users-test-work-craft-agents";
  const firstPrompt = options?.firstPrompt
    ?? "Explore the codebase to understand the current font system implementation.";

  const projectDir = path.join(testHome, ".claude", "projects", encodedProjectDirName);
  const subagentDir = path.join(projectDir, parentSessionId, "subagents");
  await fs.mkdir(subagentDir, { recursive: true });

  const lines = [
    JSON.stringify({
      parentUuid: null,
      isSidechain: true,
      userType: "external",
      cwd,
      sessionId: parentSessionId,
      agentId: subagentId.replace(/^agent-/, ""),
      type: "user",
      message: { role: "user", content: firstPrompt },
      uuid: "u-1",
      timestamp: "2026-01-20T07:01:24.654Z",
    }),
    JSON.stringify({
      parentUuid: "u-1",
      isSidechain: true,
      cwd,
      sessionId: parentSessionId,
      agentId: subagentId.replace(/^agent-/, ""),
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 3,
          output_tokens: 8,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 0,
        },
      },
      uuid: "u-2",
      timestamp: "2026-01-20T07:01:26.087Z",
    }),
    "",
  ];

  await fs.writeFile(
    path.join(subagentDir, `${subagentId}.jsonl`),
    lines.join("\n"),
    "utf8",
  );
}

export async function createClaudeSubagentFixture(testHome: string, options?: {
  eurekaSessionId?: string;
  parentSessionId?: string;
  subagentId?: string;
  workingDirectory?: string;
  includeIndex?: boolean;
  encodedProjectDirName?: string;
}): Promise<void> {
  const eurekaSessionId = options?.eurekaSessionId ?? "debug-session";
  const parentSessionId = options?.parentSessionId ?? "parent-session-1";
  const subagentId = options?.subagentId ?? "agent-sub-1";
  const workingDirectory = options?.workingDirectory ?? path.join(testHome, "work", "lumina-sandbox");
  const includeIndex = options?.includeIndex ?? true;
  const encodedProjectDirName = options?.encodedProjectDirName
    ?? `-Users-test--craft-agent-workspaces-workspace-1-sessions-${eurekaSessionId}`;

  const projectDir = path.join(testHome, ".claude", "projects", encodedProjectDirName);
  const subagentDir = path.join(projectDir, parentSessionId, "subagents");
  const eurekaSessionDir = path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", eurekaSessionId);

  await fs.mkdir(subagentDir, { recursive: true });
  await fs.mkdir(eurekaSessionDir, { recursive: true });

  await fs.writeFile(
    path.join(eurekaSessionDir, "session.jsonl"),
    [
      JSON.stringify({
        id: eurekaSessionId,
        createdAt: Date.parse("2026-04-12T01:25:22.163Z"),
        lastUsedAt: Date.parse("2026-04-12T01:50:11.784Z"),
        name: "Parent Eureka session",
        engine: "claude",
        runtimeProvider: "claude_agent_sdk",
        type: "task",
        workingDirectory,
        sdkCwd: path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", eurekaSessionId),
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  if (includeIndex) {
    await fs.writeFile(
      path.join(projectDir, "sessions-index.json"),
      JSON.stringify({
        entries: [
          {
            sessionId: parentSessionId,
            fullPath: `${parentSessionId}.jsonl`,
            fileMtime: Date.now(),
            created: new Date("2026-04-12T01:25:22.163Z").toISOString(),
            modified: new Date("2026-04-12T01:50:11.784Z").toISOString(),
            projectPath: path.join(testHome, ".craft-agent", "workspaces", "workspace-1", "sessions", eurekaSessionId),
          },
        ],
      }, null, 2),
      "utf8",
    );
  }

  await fs.writeFile(
    path.join(subagentDir, `${subagentId}.jsonl`),
    buildClaudeTranscript({
      sessionId: subagentId,
      firstPrompt: "Check child task",
      model: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationTokens: 0,
      cacheReadTokens: 60,
      transcript: "basic",
    }),
    "utf8",
  );
}

function buildClaudeTranscript(options: {
  sessionId: string;
  firstPrompt: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  transcript: "basic" | "rich" | "malformed";
}): string {
  const {
    sessionId,
    firstPrompt,
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    transcript,
  } = options;

  const lines = [
    JSON.stringify({ type: "user", sessionId, message: { role: "user", content: [{ type: "text", text: firstPrompt }] } }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      message: {
        role: "assistant",
        model,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreationTokens,
          cache_read_input_tokens: cacheReadTokens,
        },
        content: transcript === "rich"
          ? [
              { type: "thinking", thinking: "Inspecting the file and planning the fix." },
              { type: "text", text: "I found the issue in the auth flow." },
              { type: "tool_use", name: "Read", input: { file: "src/auth.ts" }, tool_use_id: "tool-1" },
            ]
          : [
              { type: "text", text: "Here is the fix" },
              { type: "tool_use", name: "Read", input: { file: "src/auth.ts" } },
            ],
      },
    }),
  ];

  if (transcript === "rich" || transcript === "malformed") {
    lines.push(JSON.stringify({
      type: "user",
      sessionId,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", output: "File contents", is_error: false }],
      },
    }));
  }

  if (transcript === "malformed") {
    lines.push('{"type":"assistant"');
  }

  lines.push("");
  return lines.join("\n");
}

function defaultPricingSnapshot(): PricingSnapshot {
  return {
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "test",
    pricing: {
      "claude-sonnet-4": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_creation_input_token_cost: 0.00000375,
        cache_read_input_token_cost: 0.0000003,
      },
      "claude-opus-4.6": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_creation_input_token_cost: 0.00000375,
        cache_read_input_token_cost: 0.0000003,
      },
      "gpt-4.1": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000008,
        cache_creation_input_token_cost: 0.0000025,
        cache_read_input_token_cost: 0.0000005,
      },
    },
  };
}
