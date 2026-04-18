import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

export interface MarsWorkspaceRow {
  idHex: string;
  name: string;
  path: string;
}

export interface MarsTaskRow {
  idHex: string;
  workspaceIdHex?: string;
  title: string;
  status?: string;
}

export interface MarsSessionRow {
  idHex: string;
  workspaceIdHex?: string;
  taskIdHex?: string;
  agentType: string;
  agentSessionId?: string;
  name?: string;
  isBackground?: number;
  phaseOrder?: number;
  updatedAt?: string;
}

interface MarsDbFixtureInput {
  homeDir: string;
  appId?: "com.marsiwe.app" | "com.marsiwe.app.dev";
  workspaces?: MarsWorkspaceRow[];
  tasks?: MarsTaskRow[];
  sessions?: MarsSessionRow[];
}

// Mirror src/core/config.ts:getMarsAppSupportDirectories() so the fixture
// writes the Mars DB to the platform-correct location under the test home.
function marsAppDir(homeDir: string, appId: string): string {
  return marsAppDirForTest(homeDir, appId);
}

export function marsAppDirForTest(homeDir: string, appId: string): string {
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", appId);
  }
  if (process.platform === "win32") {
    return path.join(homeDir, "AppData", "Roaming", appId);
  }
  return path.join(homeDir, ".config", appId);
}

export async function createMarsDbFixture(input: MarsDbFixtureInput): Promise<string> {
  const appId = input.appId ?? "com.marsiwe.app";
  const appDir = marsAppDir(input.homeDir, appId);
  await fs.mkdir(appDir, { recursive: true });
  const dbPath = path.join(appDir, "marsiwe.db");
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE workspaces (
      id BLOB PRIMARY KEY,
      name TEXT,
      path TEXT,
      status TEXT
    );
    CREATE TABLE tasks (
      id BLOB PRIMARY KEY,
      workspace_id BLOB,
      title TEXT,
      status TEXT,
      updated_at TEXT
    );
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

  const insertWorkspace = db.prepare(
    `INSERT INTO workspaces (id, name, path, status) VALUES (?, ?, ?, 'active')`,
  );
  for (const workspace of input.workspaces ?? []) {
    insertWorkspace.run(hexToBuffer(workspace.idHex), workspace.name, workspace.path);
  }

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, status, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const task of input.tasks ?? []) {
    insertTask.run(
      hexToBuffer(task.idHex),
      task.workspaceIdHex ? hexToBuffer(task.workspaceIdHex) : null,
      task.title,
      task.status ?? "todo",
      new Date().toISOString(),
    );
  }

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, workspace_id, task_id, agent_type, agent_session_id, name, is_background, phase_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const session of input.sessions ?? []) {
    insertSession.run(
      hexToBuffer(session.idHex),
      session.workspaceIdHex ? hexToBuffer(session.workspaceIdHex) : null,
      session.taskIdHex ? hexToBuffer(session.taskIdHex) : null,
      session.agentType,
      session.agentSessionId ?? null,
      session.name ?? null,
      session.isBackground ?? 0,
      session.phaseOrder ?? 0,
      session.updatedAt ?? new Date().toISOString(),
    );
  }

  db.close();
  return dbPath;
}

export async function createMarsAgentConfigRoots(homeDir: string, appId: "com.marsiwe.app" | "com.marsiwe.app.dev" = "com.marsiwe.app"): Promise<{ claude: string; codex: string; copilot: string }> {
  const base = path.join(marsAppDir(homeDir, appId), "agent-configs");
  const claude = path.join(base, "claude");
  const codex = path.join(base, "codex");
  const copilot = path.join(base, "copilot");
  await fs.mkdir(claude, { recursive: true });
  await fs.mkdir(codex, { recursive: true });
  await fs.mkdir(copilot, { recursive: true });
  return { claude, codex, copilot };
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.toLowerCase(), "hex");
}
