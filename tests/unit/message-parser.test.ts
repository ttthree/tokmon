import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseClaudeCodeMessages, parseClaudeCodeMessagesDetailed } from "../../src/core/message-parser.js";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("message parser", () => {
  it("parses user text, assistant thinking/text/tool use, and tool results", async () => {
    const filePath = await writeJsonl([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Investigate the bug" }] } },
      {
        type: "assistant",
        timestamp: "2026-04-12T10:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          usage: { input_tokens: 123, output_tokens: 45 },
          content: [
            { type: "thinking", thinking: "Check the auth path first." },
            { type: "text", text: "I found the issue." },
            { type: "tool_use", name: "Read", input: { file: "src/auth.ts" }, tool_use_id: "tool-1" },
          ],
        },
      },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", output: "file contents", tool_use_id: "tool-1" }] } },
    ]);

    const messages = await parseClaudeCodeMessages(filePath);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      role: "user",
      blocks: [{ type: "text", text: "Investigate the bug" }],
      timestamp: undefined,
      tokens: undefined,
    });
    expect(messages[1]).toEqual({
      role: "assistant",
      blocks: [
        { type: "thinking", text: "Check the auth path first." },
        { type: "text", text: "I found the issue." },
        { type: "tool_use", name: "Read", input: '{"file":"src/auth.ts"}', toolUseId: "tool-1" },
      ],
      timestamp: "2026-04-12T10:00:00.000Z",
      model: "claude-sonnet-4",
      tokens: { input: 123, output: 45 },
    });
    expect(messages[2]).toEqual({
      role: "assistant",
      blocks: [{ type: "tool_result", output: "file contents", toolUseId: "tool-1", isError: false }],
      timestamp: undefined,
      tokens: undefined,
    });
  });

  it("returns an empty array for an empty file", async () => {
    const filePath = await writeRaw("");
    await expect(parseClaudeCodeMessages(filePath)).resolves.toEqual([]);
  });

  it("truncates long tool input, output, and thinking text", async () => {
    const filePath = await writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "a".repeat(2500) },
            { type: "tool_use", name: "Write", input: { body: "b".repeat(700) } },
          ],
        },
      },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", output: "c".repeat(700), is_error: true }] } },
    ]);

    const messages = await parseClaudeCodeMessages(filePath);
    const thinking = messages[0].blocks[0];
    const toolUse = messages[0].blocks[1];
    const toolResult = messages[1].blocks[0];

    expect(thinking).toMatchObject({ type: "thinking" });
    expect((thinking as { text: string }).text).toHaveLength(2003);
    expect(toolUse).toMatchObject({ type: "tool_use" });
    expect((toolUse as { input: string }).input).toHaveLength(503);
    expect(toolResult).toMatchObject({ type: "tool_result", isError: true });
    expect((toolResult as { output: string }).output).toHaveLength(503);
  });

  it("skips malformed JSON lines but reports partial parse errors", async () => {
    const filePath = await writeRaw([
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      '{"type":"assistant"',
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "world" }] } }),
    ].join("\n"));

    const result = await parseClaudeCodeMessagesDetailed(filePath);

    expect(result.hadParseErrors).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("skips lines with no recognizable role or mixed user content", async () => {
    const filePath = await writeJsonl([
      { foo: "bar" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }, { type: "tool_result", output: "ignored" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "kept" }] } },
    ]);

    await expect(parseClaudeCodeMessages(filePath)).resolves.toEqual([
      { role: "assistant", blocks: [{ type: "text", text: "kept" }], timestamp: undefined, model: undefined, tokens: undefined },
    ]);
  });

  it("handles files with only user messages or only assistant messages", async () => {
    const userOnlyPath = await writeJsonl([{ type: "user", message: { role: "user", content: [{ type: "text", text: "user only" }] } }]);
    expect(await parseClaudeCodeMessages(userOnlyPath)).toHaveLength(1);

    const assistantOnlyPath = await writeJsonl([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "assistant only" }] } }]);
    expect(await parseClaudeCodeMessages(assistantOnlyPath)).toHaveLength(1);
  });
});

async function writeJsonl(lines: unknown[]): Promise<string> {
  return writeRaw(lines.map((line) => JSON.stringify(line)).join("\n"));
}

async function writeRaw(content: string): Promise<string> {
  if (!tempDir) {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-message-parser-"));
  }

  const filePath = path.join(tempDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}
