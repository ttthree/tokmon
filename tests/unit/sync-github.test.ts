import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildLatestSnapshotPushArgs,
  createLatestSnapshotCommit,
  getRepoCacheKey,
  isGitHubSyncDue,
  resolveGitCloneTarget,
} from "../../src/sync/github.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout;
}

describe("GitHub sync repo parsing", () => {
  it("expands owner slash repo shorthand to GitHub HTTPS", () => {
    expect(resolveGitCloneTarget("ttthree/tokmon-data")).toBe("https://github.com/ttthree/tokmon-data.git");
  });

  it("preserves SSH remotes and host aliases", () => {
    expect(resolveGitCloneTarget("git@gh:ttthree/tokmon-data")).toBe("git@gh:ttthree/tokmon-data");
    expect(resolveGitCloneTarget("git@github.com:ttthree/tokmon-data.git")).toBe("git@github.com:ttthree/tokmon-data.git");
  });

  it("builds stable cache keys for SSH remotes", () => {
    expect(getRepoCacheKey("git@gh:ttthree/tokmon-data")).toBe("git-gh-ttthree-tokmon-data");
  });

  it("builds force-with-lease push args for snapshot updates", () => {
    expect(buildLatestSnapshotPushArgs("main", "abc123")).toEqual([
      "push",
      "--force-with-lease=refs/heads/main:abc123",
      "origin",
      "HEAD:refs/heads/main",
    ]);
  });

  it("treats scheduled sync as due when no prior sync state exists", () => {
    expect(isGitHubSyncDue({ repo: "owner/repo", branch: "main", syncIntervalMinutes: 60 }, null, Date.UTC(2026, 3, 22, 8, 0, 0))).toBe(true);
  });

  it("skips scheduled sync until the sync interval elapses", () => {
    const github = { repo: "owner/repo", branch: "main", syncIntervalMinutes: 60 };
    const state = { repo: "owner/repo", branch: "main", lastSuccessfulSyncAt: "2026-04-22T07:30:00.000Z" };
    expect(isGitHubSyncDue(github, state, Date.UTC(2026, 3, 22, 8, 0, 0))).toBe(false);
    expect(isGitHubSyncDue(github, state, Date.UTC(2026, 3, 22, 8, 30, 0))).toBe(true);
  });

  it("forces an immediate scheduled sync when repo settings change", () => {
    const state = { repo: "owner/repo", branch: "main", lastSuccessfulSyncAt: "2026-04-22T07:50:00.000Z" };
    expect(isGitHubSyncDue({ repo: "owner/other", branch: "main", syncIntervalMinutes: 60 }, state, Date.UTC(2026, 3, 22, 8, 0, 0))).toBe(true);
    expect(isGitHubSyncDue({ repo: "owner/repo", branch: "develop", syncIntervalMinutes: 60 }, state, Date.UTC(2026, 3, 22, 8, 0, 0))).toBe(true);
  });
});

describe("latest snapshot commits", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("rewrites local history to a single commit while preserving files", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "tokmon-sync-test-"));
    tempDirs.push(repoDir);

    await execFileAsync("git", ["init", "--initial-branch=main", repoDir]);
    await git(repoDir, ["config", "user.name", "Tokmon Test"]);
    await git(repoDir, ["config", "user.email", "tokmon@example.com"]);

    await fs.mkdir(path.join(repoDir, "machines"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "machines", "machine-a.json"), '{"sessions":1}\n', "utf8");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", "first"]);

    await fs.writeFile(path.join(repoDir, "machines", "machine-a.json"), '{"sessions":2}\n', "utf8");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", "second"]);

    await createLatestSnapshotCommit(repoDir, "snapshot");

    expect((await git(repoDir, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
    expect(await fs.readFile(path.join(repoDir, "machines", "machine-a.json"), "utf8")).toContain('"sessions":2');
  });
});
