#!/usr/bin/env tsx
/**
 * One-shot dev launcher: starts the API (`npm run dev`) and the Vite HMR
 * server (`npm run dev:web`) side-by-side, multiplexes their stdout with
 * colored prefixes, and shuts both down cleanly on Ctrl+C.
 *
 * Pass-through args go to the API command. Examples:
 *   npm run dev:all
 *   npm run dev:all -- --port 3456
 *
 * Port handling: dev-all decides the API port up-front (either the
 * caller's `--port`, or the first free port starting from 3000), passes
 * it explicitly to the API so it cannot silently fall back, and exports
 * `TOKMON_API_URL` into the Vite child so the proxy follows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import readline from "node:readline";

interface Proc {
  name: string;
  color: (s: string) => string;
  child: ChildProcess;
}

const RESET = "\x1b[0m";
const color = (code: string) => (s: string) => `\x1b[${code}m${s}${RESET}`;
const cyan = color("36");
const magenta = color("35");
const red = color("31");

function launch(
  name: string,
  paint: (s: string) => string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Proc {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    shell: false,
  });
  const tag = paint(`[${name}]`);
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => process.stdout.write(`${tag} ${line}\n`));
  }
  child.on("exit", (code, signal) => {
    process.stdout.write(`${tag} ${red(`exited (code=${code ?? "null"} signal=${signal ?? "null"})`)}\n`);
    shutdown(code ?? 0);
  });
  return { name, color: paint, child };
}

const userArgs = process.argv.slice(2);

// If the caller passed `--port`, honor it (and don't second-guess); otherwise
// pick the first free port at/after 3000 ourselves so we never race with the
// API's own auto-fallback (which would leave Vite pointing at the wrong
// process).
function findArg(args: string[], flag: string): { idx: number; value?: string } {
  const idx = args.findIndex((a) => a === flag);
  if (idx === -1) return { idx: -1 };
  return { idx, value: args[idx + 1] };
}

async function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickFreePort(start = 3000, end = 3050): Promise<number> {
  for (let p = start; p <= end; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`[dev-all] no free port available in ${start}..${end}`);
}

async function waitForApiReady(port: number, host = "127.0.0.1", timeoutMs = 30_000): Promise<void> {
  // Probe the actual /api/data endpoint rather than just a TCP connect, so a
  // pre-existing listener on this port can't be mistaken for our API.
  const url = `http://${host}:${port}/api/data`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      // Any 2xx/4xx from our server is a positive signal — only ECONNREFUSED /
      // network errors mean "not yet up".
      if (res.status > 0) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stdout.write(red(`[dev-all] timed out waiting for API on :${port}\n`));
}

const procs: Proc[] = [];

void (async () => {
  const portArg = findArg(userArgs, "--port");
  let apiPort: number;
  let finalArgs = userArgs.slice();

  if (portArg.idx >= 0 && portArg.value) {
    apiPort = Number(portArg.value);
  } else {
    apiPort = await pickFreePort();
    // Pass --port explicitly so the API treats it as user-specified and
    // disables auto-fallback.
    finalArgs = [...userArgs, "--port", String(apiPort)];
  }

  process.stdout.write(cyan(`[dev-all] API port → :${apiPort}\n`));

  procs.push(launch("api", cyan, "npx", ["tsx", "src/cli/index.ts", ...finalArgs]));

  await waitForApiReady(apiPort);

  procs.push(
    launch("web", magenta, "npx", ["vite"], {
      ...process.env,
      TOKMON_API_URL: `http://127.0.0.1:${apiPort}`,
    }),
  );
})();

let exiting = false;
function shutdown(code: number) {
  if (exiting) return;
  exiting = true;
  for (const p of procs) {
    if (!p.child.killed) p.child.kill("SIGTERM");
  }
  // Give children a moment to exit cleanly before we go.
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
