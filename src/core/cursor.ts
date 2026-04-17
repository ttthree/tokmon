import fs from "node:fs/promises";

import type { CursorState, FileCursor } from "./types.js";

export function createEmptyCursorState(): CursorState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    files: {},
  };
}

export function mergeCursorState(existing: CursorState, updates: Record<string, FileCursor>): CursorState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    files: {
      ...existing.files,
      ...updates,
    },
  };
}

export async function statCursor(path: string): Promise<Pick<FileCursor, "inode" | "size" | "mtimeMs">> {
  const stat = await fs.stat(path);
  return {
    inode: Number(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export function shouldResumeFromOffset(cursor: FileCursor | null | undefined, stat: Pick<FileCursor, "inode" | "size">): boolean {
  return Boolean(cursor && cursor.inode === stat.inode && cursor.size <= stat.size);
}
