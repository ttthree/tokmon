import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { resetSanitizeState, sanitizeCopilotLog, sanitizeJsonlLine, sanitizePath, sanitizeSensitiveText, sanitizeSqlite } from "../../../src/cli/commands/corpus/sanitize.js";

let tempDir = "";
const username = os.userInfo().username;

afterEach(async () => {
  resetSanitizeState();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("corpus sanitize", () => {
  it("sanitizePath rewrites username paths", () => {
    const input = `/Users/${username}/work/project`;
    expect(sanitizePath(input)).toContain("/Users/testuser/");
  });

  it("sanitizeSensitiveText rewrites username suffix variants", () => {
    const input = `owner=${username}_microsoft reviewer=${username.toUpperCase()}-team`;
    const out = sanitizeSensitiveText(input);
    expect(out).not.toMatch(new RegExp(username, "i"));
    expect(out).toContain("testuser");
  });

  it("sanitizeJsonlLine cc keeps model/usage and blanks text", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      message: {
        role: "assistant",
        model: "claude-opus",
        usage: { input_tokens: 10 },
        content: [{ type: "text", text: "secret" }],
      },
    });
    const out = JSON.parse(sanitizeJsonlLine(line, "cc") ?? "{}");
    expect(out.message.model).toBe("claude-opus");
    expect(out.message.usage.input_tokens).toBe(10);
    expect(out.message.content[0].text).toBe("");
  });

  it("sanitizeJsonlLine eureka-header rewrites name and workingDirectory", () => {
    const line = JSON.stringify({ id: "abc", name: "secret", workingDirectory: `/Users/${username}/work/x` });
    const out = JSON.parse(sanitizeJsonlLine(line, "eureka-header") ?? "{}");
    expect(out.name).toBe("session-1");
    expect(out.workingDirectory).toContain("/Users/testuser/");
  });

  it("sanitizeJsonlLine telemetry nulls prompt/response", () => {
    const line = JSON.stringify({ timestamp: "2026-04-18T00:00:00.000Z", provider: "anthropic", prompt: "abc", response: "xyz" });
    const out = JSON.parse(sanitizeJsonlLine(line, "telemetry") ?? "{}");
    expect(out.prompt).toBeNull();
    expect(out.response).toBeNull();
  });

  it("sanitizeJsonlLine codex preserves total_token_usage", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 7 } } } });
    const out = JSON.parse(sanitizeJsonlLine(line, "codex") ?? "{}");
    expect(out.payload.info.total_token_usage.input_tokens).toBe(7);
  });

  it("sanitizeSqlite codex keeps reduced schema", async () => {
    tempDir = await fs.mkdtemp(path.join(process.cwd(), "tmp-sanitize-"));
    const src = path.join(tempDir, "in.sqlite");
    const dst = path.join(tempDir, "out.sqlite");
    const db = new Database(src);
    db.exec("CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, tokens_used INTEGER);");
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)").run("t1", `/Users/${username}/work`, "hello", 1, 2, 3);
    db.close();

    await sanitizeSqlite(src, dst, "codex");
    const outDb = new Database(dst, { readonly: true, fileMustExist: true });
    const row = outDb.prepare("SELECT id, cwd, title, tokens_used FROM threads").get() as { id: string; cwd: string; title: string; tokens_used: number };
    outDb.close();
    expect(row.id).toBe("t1");
    expect(row.cwd).toContain("/Users/testuser/");
    expect(row.title).toBe("thread-1");
    expect(row.tokens_used).toBe(3);
  });

  it("sanitizeCopilotLog keeps only assistant_usage and model_call events", () => {
    const raw = [
      "2026-04-18T01:00:00.000Z [INFO] [Telemetry] cli.telemetry:",
      JSON.stringify({ kind: "assistant_usage", properties: { model: "claude", interaction_id: "x", api_call_id: "a" }, metrics: { input_tokens: 1, output_tokens: 2 } }),
      "2026-04-18T01:00:01.000Z [INFO] [Telemetry] cli.telemetry:",
      JSON.stringify({ kind: "other_event", text: "drop me" }),
      "2026-04-18T01:00:02.000Z [INFO] [Telemetry] cli.model_call:",
      JSON.stringify({ model: "gpt-4.1", prompt_tokens_count: 3, completion_tokens_count: 4, user: `${username}_microsoft` }),
      "",
    ].join("\n");
    const out = sanitizeCopilotLog(raw);
    expect(out).toContain('"kind":"assistant_usage"');
    expect(out).toContain("cli.model_call:");
    expect(out).not.toContain("other_event");
    expect(out).not.toMatch(new RegExp(username, "i"));
  });
});
