import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { streamJsonl } from "../../../src/parsers/util/jsonl-stream.js";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("jsonl stream", () => {
  it("returns empty stats for a zero-byte file", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-jsonl-"));
    const filePath = path.join(tempDir, "empty.jsonl");
    await fs.writeFile(filePath, "", "utf8");

    const seen: unknown[] = [];
    const result = await streamJsonl(filePath, (obj) => seen.push(obj));

    expect(result).toEqual({ linesRead: 0, bytesRead: 0 });
    expect(seen).toEqual([]);
  });

  it("streams a single parsed line", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-jsonl-"));
    const filePath = path.join(tempDir, "single.jsonl");
    await fs.writeFile(filePath, `${JSON.stringify({ a: 1 })}\n`, "utf8");

    const seen: Array<Record<string, number>> = [];
    const result = await streamJsonl(filePath, (obj) => seen.push(obj as Record<string, number>));

    expect(result?.linesRead).toBe(1);
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("skips malformed lines and parses a truncated final line", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-jsonl-"));
    const filePath = path.join(tempDir, "mixed.jsonl");
    await fs.writeFile(filePath, `${JSON.stringify({ ok: 1 })}\n{"broken"\n${JSON.stringify({ ok: 2 })}`, "utf8");

    const seen: number[] = [];
    const result = await streamJsonl(filePath, (obj) => {
      seen.push((obj as { ok: number }).ok);
    });

    expect(result?.linesRead).toBe(3);
    expect(seen).toEqual([1, 2]);
  });

  it("returns null for a missing file", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-jsonl-"));
    const result = await streamJsonl(path.join(tempDir, "missing.jsonl"), () => undefined);
    expect(result).toBeNull();
  });

  it("stays memory-bounded for large files", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-jsonl-"));
    const filePath = path.join(tempDir, "large.jsonl");
    const chunk = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ index: i, payload: "x".repeat(64) })).join("\n") + "\n";
    await fs.writeFile(filePath, chunk.repeat(20), "utf8");

    const before = process.memoryUsage().heapUsed;
    let count = 0;
    const result = await streamJsonl(filePath, () => {
      count += 1;
    });
    const after = process.memoryUsage().heapUsed;

    expect(result?.linesRead).toBe(100000);
    expect(count).toBe(100000);
    expect(after - before).toBeLessThan(50 * 1024 * 1024);
  });
});
