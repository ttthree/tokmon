import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { encodeClaudeProjectPath } from "../../../src/core/source-resolver.js";
import { createEmptyCursorState } from "../../../src/core/cursor.js";
import { claudeCodeParser } from "../../../src/parsers/claude-code.js";
import { createTestHome } from "../../helpers/fixtures.js";

let testHome = "";

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
  delete process.env.TOKMON_HOME;
});

describe("claude parser large files", () => {
  it("streams a 6MB jsonl without dropping usage", async () => {
    testHome = await createTestHome();
    process.env.TOKMON_HOME = testHome;

    const projectPath = path.join(testHome, "work", "big-claude-project");
    const projectDir = path.join(testHome, ".claude", "projects", encodeClaudeProjectPath(projectPath) ?? "big-claude-project");
    const sessionId = "large-claude-session";
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
    const repeatCount = 15000;
    const inputPerLine = 11;
    const outputPerLine = 7;
    const cacheCreatePerLine = 3;
    const cacheReadPerLine = 2;

    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "sessions-index.json"),
      JSON.stringify({
        entries: [{
          sessionId,
          fullPath: `${sessionId}.jsonl`,
          fileMtime: Date.now(),
          firstPrompt: "Scan the repository",
          summary: "Large session",
          messageCount: repeatCount + 1,
          created: "2026-04-18T10:00:00.000Z",
          modified: "2026-04-18T10:30:00.000Z",
          projectPath,
          isSidechain: false,
        }],
      }, null, 2),
      "utf8",
    );

    const filler = "x".repeat(220);
    const userLine = `${JSON.stringify({ type: "user", timestamp: "2026-04-18T10:00:00.000Z", sessionId, message: { role: "user", content: [{ type: "text", text: "Scan the repository" }] } })}\n`;
    const assistantLine = `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-18T10:00:01.000Z",
      sessionId,
      message: {
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: inputPerLine,
          output_tokens: outputPerLine,
          cache_creation_input_tokens: cacheCreatePerLine,
          cache_read_input_tokens: cacheReadPerLine,
        },
        content: [{ type: "text", text: filler }],
      },
    })}\n`;

    await fs.writeFile(sessionFile, userLine, "utf8");
    const chunk = assistantLine.repeat(500);
    for (let index = 0; index < repeatCount / 500; index += 1) {
      await fs.appendFile(sessionFile, chunk, "utf8");
    }

    const stat = await fs.stat(sessionFile);
    expect(stat.size).toBeGreaterThan(6 * 1024 * 1024);

    const result = await claudeCodeParser.parse({ machineId: "machine-1", existingCursor: createEmptyCursorState() });
    expect(result.sessions).toHaveLength(1);

    const session = result.sessions[0];
    expect(session.tokens).toEqual({
      input: repeatCount * inputPerLine,
      output: repeatCount * outputPerLine,
      cacheCreation: repeatCount * cacheCreatePerLine,
      cacheRead: repeatCount * cacheReadPerLine,
    });
    expect(session.modelUsage).toEqual({
      "claude-sonnet-4-20250514": {
        input: repeatCount * inputPerLine,
        output: repeatCount * outputPerLine,
        cacheCreation: repeatCount * cacheCreatePerLine,
        cacheRead: repeatCount * cacheReadPerLine,
      },
    });
    expect(session.tokenProvenance).toBe("sdk-cc-jsonl");
  }, 20000);
});
