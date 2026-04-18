import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { encodeClaudeProjectPath } from "../../../src/core/source-resolver.js";

export const EDGE_EPOCH = Date.parse("2026-04-18T00:00:00.000Z");

export interface ClaudeAssistantTurn {
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  timestamp: string;
}

export interface ClaudeSessionOptions {
  claudeRoot: string;
  projectPath: string;
  sessionId: string;
  summary: string;
  firstPrompt: string;
  createdAt: string;
  modifiedAt: string;
  assistantTurns: ClaudeAssistantTurn[];
  malformedLine?: string;
}

export interface EurekaHeaderOptions {
  id: string;
  name: string;
  engine: string;
  model: string;
  workingDirectory: string;
  createdAt: string;
  lastUsedAt: string;
  sdkSessionId?: string;
  sdkCwd?: string;
}

export async function writePricingSnapshot(homeDir: string): Promise<void> {
  const pricingDir = path.join(homeDir, ".tokmon", "pricing");
  await fs.mkdir(pricingDir, { recursive: true });
  const snapshot = {
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "edge-fixtures",
    pricing: {},
  };
  await fs.writeFile(path.join(pricingDir, "latest.json"), JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export async function writeClaudeSession(options: ClaudeSessionOptions): Promise<string> {
  const encoded = encodeClaudeProjectPath(options.projectPath);
  if (!encoded) throw new Error(`Unable to encode Claude project path: ${options.projectPath}`);

  const projectDir = path.join(options.claudeRoot, "projects", encoded);
  const sessionPath = path.join(projectDir, `${options.sessionId}.jsonl`);
  await fs.mkdir(projectDir, { recursive: true });

  const transcript = [
    JSON.stringify({
      type: "user",
      sessionId: options.sessionId,
      timestamp: options.createdAt,
      cwd: options.projectPath,
      message: { role: "user", content: [{ type: "text", text: options.firstPrompt }] },
    }),
    ...options.assistantTurns.map((turn) => JSON.stringify({
      type: "assistant",
      sessionId: options.sessionId,
      timestamp: turn.timestamp,
      cwd: options.projectPath,
      message: {
        role: "assistant",
        model: turn.model,
        content: [{ type: "text", text: `reply from ${turn.model}` }],
        usage: {
          input_tokens: turn.input,
          output_tokens: turn.output,
          cache_creation_input_tokens: turn.cacheCreation,
          cache_read_input_tokens: turn.cacheRead,
        },
      },
    })),
  ];

  if (options.malformedLine) transcript.splice(2, 0, options.malformedLine);

  await fs.writeFile(sessionPath, transcript.join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(projectDir, "sessions-index.json"), JSON.stringify({
    entries: [{
      sessionId: options.sessionId,
      fullPath: `${options.sessionId}.jsonl`,
      fileMtime: Date.parse(options.modifiedAt),
      firstPrompt: options.firstPrompt,
      summary: options.summary,
      messageCount: transcript.length,
      created: options.createdAt,
      modified: options.modifiedAt,
      projectPath: options.projectPath,
      isSidechain: false,
    }],
  }, null, 2) + "\n", "utf8");

  return sessionPath;
}

export async function writeClaudeSubagent(
  claudeRoot: string,
  projectPath: string,
  parentSessionId: string,
  subagentFileName: string,
  firstPrompt: string,
  turn: ClaudeAssistantTurn,
): Promise<string> {
  const encoded = encodeClaudeProjectPath(projectPath);
  if (!encoded) throw new Error(`Unable to encode Claude project path: ${projectPath}`);

  const subagentsDir = path.join(claudeRoot, "projects", encoded, parentSessionId, "subagents");
  await fs.mkdir(subagentsDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: "user", sessionId: parentSessionId, timestamp: turn.timestamp, cwd: projectPath, message: { role: "user", content: firstPrompt } }),
    JSON.stringify({
      type: "assistant",
      sessionId: parentSessionId,
      timestamp: turn.timestamp,
      cwd: projectPath,
      message: {
        role: "assistant",
        model: turn.model,
        content: [{ type: "text", text: "subagent" }],
        usage: {
          input_tokens: turn.input,
          output_tokens: turn.output,
          cache_creation_input_tokens: turn.cacheCreation,
          cache_read_input_tokens: turn.cacheRead,
        },
      },
    }),
  ];

  const filePath = path.join(subagentsDir, subagentFileName);
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

export async function writeEurekaSession(sessionRoot: string, header: EurekaHeaderOptions): Promise<string> {
  await fs.mkdir(sessionRoot, { recursive: true });
  const sessionJsonl = path.join(sessionRoot, "session.jsonl");
  await fs.writeFile(sessionJsonl, JSON.stringify({
    id: header.id,
    createdAt: Date.parse(header.createdAt),
    lastUsedAt: Date.parse(header.lastUsedAt),
    name: header.name,
    engine: header.engine,
    model: header.model,
    runtimeProvider: header.engine === "codex" ? "codex_agent_sdk" : "claude_agent_sdk",
    type: "task",
    messageCount: 4,
    userMessageCount: 2,
    workingDirectory: header.workingDirectory,
    sdkSessionId: header.sdkSessionId,
    sdkCwd: header.sdkCwd,
  }) + "\n", "utf8");
  return sessionJsonl;
}

export async function writeCodexState(rootDir: string, rows: Array<{
  id: string;
  cwd: string;
  model: string;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
  title: string;
}>): Promise<string> {
  await fs.mkdir(rootDir, { recursive: true });
  const dbPath = path.join(rootDir, "state_1.sqlite");
  const db = new Database(dbPath);
  try {
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
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      insert.run(
        row.id,
        row.cwd,
        row.model,
        row.provider,
        Math.floor(Date.parse(row.createdAt) / 1000),
        Math.floor(Date.parse(row.updatedAt) / 1000),
        0,
        row.title,
        0,
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

export async function writeCodexRollout(filePath: string, lines: Array<Record<string, unknown>>): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return filePath;
}

export async function writeMarsDatabase(appDir: string, options: {
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  sessions: Array<{
    id: string;
    agentType: string;
    agentSessionId: string;
    name: string;
    updatedAt: string;
  }>;
}): Promise<string> {
  await fs.mkdir(appDir, { recursive: true });
  const dbPath = path.join(appDir, "marsiwe.db");
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE tasks (id BLOB PRIMARY KEY, title TEXT, status TEXT);");
    db.exec("CREATE TABLE workspaces (id BLOB PRIMARY KEY, name TEXT, path TEXT);");
    db.exec(`
      CREATE TABLE sessions (
        id BLOB PRIMARY KEY,
        workspace_id BLOB,
        task_id BLOB,
        agent_type TEXT,
        agent_session_id TEXT,
        name TEXT,
        is_background INTEGER,
        phase_order INTEGER,
        updated_at TEXT
      );
    `);
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?)").run(hexToBuffer(options.taskId), options.taskTitle, "done");
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?)").run(
      hexToBuffer(options.workspaceId),
      options.workspaceName,
      options.workspacePath,
    );

    const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    options.sessions.forEach((session, index) => {
      insert.run(
        hexToBuffer(session.id),
        hexToBuffer(options.workspaceId),
        hexToBuffer(options.taskId),
        session.agentType,
        session.agentSessionId,
        session.name,
        0,
        index,
        session.updatedAt,
      );
    });
  } finally {
    db.close();
  }
  return dbPath;
}

export async function stampFiles(homeDir: string): Promise<Record<string, number>> {
  const files = await listFiles(homeDir);
  const mtimes: Record<string, number> = {};
  let offset = 0;
  for (const file of files) {
    const mtimeMs = EDGE_EPOCH + offset * 1000;
    offset += 1;
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
    mtimes[path.join("home", path.relative(homeDir, file))] = mtimeMs;
  }
  return mtimes;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(root);
  return files.sort();
}

function hexToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, ""), "hex");
}
