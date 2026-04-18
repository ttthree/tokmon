import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export async function streamJsonl(
  filePath: string,
  onLine: (obj: unknown, lineNo: number) => void,
): Promise<{ linesRead: number; bytesRead: number } | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;

  try {
    for await (const line of reader) {
      lineNo += 1;
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line) as unknown, lineNo);
      } catch {
        // Skip malformed lines silently.
      }
    }
  } finally {
    reader.close();
    stream.close();
  }

  return { linesRead: lineNo, bytesRead: Number(stat.size) };
}
