import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClaudeFixture, createTestHome } from "../helpers/fixtures.js";
import { waitForExit, waitForStdout } from "./process.js";

const execFileAsync = promisify(execFile);

let testHome = "";

beforeEach(async () => {
  testHome = await createTestHome();
  await createClaudeFixture(testHome);
});

afterEach(async () => {
  await fs.rm(testHome, { recursive: true, force: true });
});

describe("tokmon CLI", () => {
  it("starts the dashboard with the default command", async () => {
    const env = { ...process.env, TOKMON_HOME: testHome };

    const port = await getAvailablePort();
    const child = spawn("node", ["--import", "tsx", "src/cli/index.ts", "--port", String(port), "--no-open"], {
      cwd: process.cwd(),
      env,
    });

    try {
      await waitForStdout(child, `Dashboard → http://localhost:${port}`);

      const response = await fetch(`http://localhost:${port}/api/data`);
      const data = await response.json() as { totals: { sessions: number } };

      expect(response.status).toBe(200);
      expect(data.totals.sessions).toBe(1);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  });

  it("fails clearly when the port is already in use", async () => {
    const env = { ...process.env, TOKMON_HOME: testHome };
    const port = await getAvailablePort();
    const first = spawn("node", ["--import", "tsx", "src/cli/index.ts", "--port", String(port), "--no-open"], {
      cwd: process.cwd(),
      env,
    });

    try {
      await waitForStdout(first, `Dashboard → http://localhost:${port}`);

      await expect(
        execFileAsync("node", ["--import", "tsx", "src/cli/index.ts", "--port", String(port), "--no-open"], {
          cwd: process.cwd(),
          env,
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining(`Port ${port} is already in use. Use --port to pick another.`) });
    } finally {
      first.kill("SIGTERM");
      await waitForExit(first);
    }
  }, 15000);
});

async function getAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}
