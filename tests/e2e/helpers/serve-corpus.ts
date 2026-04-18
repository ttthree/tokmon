import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { waitForExit } from "../process.js";

export interface CorpusServer {
  url: string;
  port: number;
  homePath: string;
  close: () => Promise<void>;
}

const READY_REGEX = /(http:\/\/localhost:\d+)/;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildDeterministicConfig(homePath: string, corpusId: string): Promise<Record<string, unknown>> {
  const candidates: Array<{ type: string; path: string; label?: string }> = [
    { type: "claude-code", path: path.join(homePath, ".claude") },
    { type: "claude-code", path: path.join(homePath, ".craft-agent", ".claude") },
    { type: "codex", path: path.join(homePath, ".codex") },
    { type: "copilot-cli", path: path.join(homePath, ".copilot") },
    { type: "eureka", path: path.join(homePath, ".craft-agent", "workspaces"), label: "Eureka workspaces (legacy)" },
    ...(corpusId === "2026-04-default" ? [{ type: "eureka", path: path.join(homePath, ".eureka", "workspaces"), label: "Eureka workspaces" }] : []),
    { type: "mars", path: path.join(homePath, "Library", "Application Support", "com.marsiwe.app") },
    ...(corpusId === "2026-04-default" ? [{ type: "mars", path: path.join(homePath, "Library", "Application Support", "com.marsiwe.app.dev") }] : []),
  ];

  const existing = await Promise.all(candidates.map(async (candidate) => ((await pathExists(candidate.path)) ? candidate : null)));
  const sources = existing
    .filter((candidate): candidate is { type: string; path: string; label?: string } => candidate !== null)
    .map((candidate) => ({
      id: `${candidate.type}:${candidate.path}`,
      type: candidate.type,
      path: candidate.path,
      enabled: true,
      autoDetected: true,
      ...(candidate.label ? { label: candidate.label } : {}),
    }));

  return {
    github: { repo: "", branch: "main" },
    privacy: {
      sync: {
        includeSummary: false,
        includeFirstPrompt: false,
        includeProjectPath: false,
        includeProjectName: true,
        includeOrchestratorMetadata: true,
      },
    },
    projects: {},
    excludeFolders: ["/tmp", "/private/var", ".worktrees", ".craft-agent", "workdirectory"],
    pricing: { autoUpdate: false, updateIntervalHours: 24 },
    sources,
    machine: {},
  };
}

async function pickEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address !== "object" || !address) {
        probe.close();
        reject(new Error("could not get ephemeral port"));
        return;
      }
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function waitForReadyLine(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";

    const onStdout = (chunk: Buffer | string) => {
      stdoutBuf += chunk.toString();
      const match = stdoutBuf.match(READY_REGEX);
      if (!match) return;
      cleanup();
      resolve(match[1]);
    };

    const onStderr = (chunk: Buffer | string) => {
      stderrBuf += chunk.toString();
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`tokmon exited with code ${code} before printing Dashboard URL.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`));
    };

    const timer = setTimeout(() => {
      cleanup();
      child.kill("SIGTERM");
      reject(new Error(`tokmon did not print Dashboard URL within ${timeoutMs}ms.\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

export async function serveCorpus(corpusId: string, opts: { timeoutMs?: number } = {}): Promise<CorpusServer> {
  const sourceHomePath = path.resolve(`tests/corpus/snapshots/${corpusId}/home`);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `tokmon-corpus-${corpusId}-`));
  const homePath = path.join(tempRoot, "home");
  await fs.cp(sourceHomePath, homePath, { recursive: true });

  const targetTokmonDir = path.join(homePath, ".tokmon");
  await fs.mkdir(targetTokmonDir, { recursive: true });
  const config = await buildDeterministicConfig(homePath, corpusId);
  await fs.writeFile(path.join(targetTokmonDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  await fs.rm(path.join(targetTokmonDir, "config.json.tmp"), { force: true }).catch(() => undefined);

  const port = await pickEphemeralPort();
  const child = spawn(
    "node",
    ["--import", "tsx", "-e", `import { serveCommand } from "./src/cli/commands/serve.ts"; await serveCommand(${port});`],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TOKMON_HOME: homePath,
        TOKMON_PRICING_DIR: path.join(homePath, ".tokmon", "pricing"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  const url = await waitForReadyLine(child, opts.timeoutMs ?? 30_000);

  return {
    url,
    port,
    homePath,
    close: async () => {
      child.kill("SIGTERM");
      await waitForExit(child);
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
