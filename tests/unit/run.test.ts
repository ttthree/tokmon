import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const collectCommand = vi.fn();
const loadConfig = vi.fn();
const isSyncConfigured = vi.fn();
const serve = vi.fn();
const syncIfDue = vi.fn();
const exec = vi.fn();

vi.mock("../../src/cli/commands/collect.js", () => ({ collectCommand }));
vi.mock("../../src/core/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/core/config.js")>("../../src/core/config.js");
  return { ...actual, loadConfig, isSyncConfigured };
});
vi.mock("../../src/server/index.js", () => ({ serve }));
vi.mock("../../src/sync/github.js", () => ({ syncIfDue }));
vi.mock("node:child_process", () => ({ exec }));

describe("run", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    collectCommand.mockResolvedValue({ sessionCount: 3, durationMs: 2100 });
    loadConfig.mockResolvedValue({ refresh: { intervalMinutes: 5 }, github: { repo: "owner/repo", branch: "main", syncIntervalMinutes: 60 } });
    isSyncConfigured.mockReturnValue(true);
    serve.mockResolvedValue(3000);
    syncIfDue.mockResolvedValue({ pulled: 2, pushed: true });
    exec.mockImplementation((_command: string, callback?: () => void) => {
      callback?.();
      return {};
    });
    vi.spyOn(global, "setInterval").mockImplementation(() => 0 as unknown as NodeJS.Timeout);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    const runModule = await import("../../src/cli/commands/run.js");
    runModule.resetBackgroundRefreshState();
    vi.restoreAllMocks();
  });

  it("calls collect, sync, and serve in order", async () => {
    const order: string[] = [];
    collectCommand.mockImplementation(async () => {
      order.push("collect");
      return { sessionCount: 3, durationMs: 2100 };
    });
    syncIfDue.mockImplementation(async () => {
      order.push("sync");
      return { pulled: 2, pushed: true };
    });
    serve.mockImplementation(async () => {
      order.push("serve");
      return 3000;
    });

    const { run } = await import("../../src/cli/commands/run.js");
    await run({ port: 3000, open: false, reset: false });

    expect(order).toEqual(["collect", "sync", "serve"]);
  });

  it("passes reset to collect and skips browser open when disabled", async () => {
    const { run } = await import("../../src/cli/commands/run.js");
    await run({ port: 3000, open: false, reset: true });

    expect(collectCommand).toHaveBeenCalledWith({ reset: true });
    expect(exec).not.toHaveBeenCalled();
  });

  it("skips sync when not configured", async () => {
    isSyncConfigured.mockReturnValue(false);

    const { run } = await import("../../src/cli/commands/run.js");
    await run({ port: 3000, open: false, reset: false });

    expect(syncIfDue).not.toHaveBeenCalled();
    expect(serve).toHaveBeenCalledWith(3000, { autoFallback: true });
  });

  it("treats sync failures as non-fatal", async () => {
    syncIfDue.mockRejectedValue(new Error("bad credentials"));

    const { run } = await import("../../src/cli/commands/run.js");
    await expect(run({ port: 3000, open: false, reset: false })).resolves.toBeUndefined();

    expect(serve).toHaveBeenCalledWith(3000, { autoFallback: true });
    expect(console.log).toHaveBeenCalledWith("⚠ GitHub sync failed: bad credentials");
  });

  it("logs when GitHub sync is skipped because it is not due", async () => {
    syncIfDue.mockResolvedValue(null);

    const { run } = await import("../../src/cli/commands/run.js");
    await run({ port: 3000, open: false, reset: false });

    expect(console.log).toHaveBeenCalledWith("  → skipped (runs every 60m)");
  });

  it("treats collect failures as fatal", async () => {
    collectCommand.mockRejectedValue(new Error("collect failed"));

    const { run } = await import("../../src/cli/commands/run.js");
    await expect(run({ port: 3000, open: false, reset: false })).rejects.toThrow("collect failed");
  });

  it("prevents overlapping background refresh runs", async () => {
    let intervalHandler: (() => Promise<void>) | undefined;
    let intervalMs: number | undefined;
    vi.spyOn(global, "setInterval").mockImplementation((handler, ms) => {
      intervalHandler = handler as () => Promise<void>;
      intervalMs = ms as number;
      return 0 as unknown as NodeJS.Timeout;
    });

    let resolveCollect: (() => void) | undefined;
    collectCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCollect = () => resolve({ sessionCount: 1, durationMs: 1 });
        }),
    );

    const runModule = await import("../../src/cli/commands/run.js");
    runModule.startBackgroundRefresh({ refresh: { intervalMinutes: 7 }, github: { repo: "owner/repo", branch: "main", syncIntervalMinutes: 60 } } as never);

    expect(intervalMs).toBe(7 * 60 * 1000);

    const firstRun = intervalHandler!();
    const secondRun = intervalHandler!();
    expect(collectCommand).toHaveBeenCalledTimes(1);

    resolveCollect?.();
    await firstRun;
    await secondRun;
  });
});
