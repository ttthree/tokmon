import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { aggregateData } from "../core/aggregate.js";
import { loadMachineData } from "../core/data.js";
import { loadMachineDataFromPathSafe, getRemoteMachinesDirectory } from "../core/config.js";
import { parseClaudeCodeMessagesDetailed, parseCodexMessagesDetailed, parseEurekaMessagesDetailed } from "../core/message-parser.js";
import { getMachineId } from "../core/machine.js";
import type { SessionMessages } from "../core/messages.js";
import { resolveSourcePath } from "../core/source-resolver.js";
import type { DataFilters, Session } from "../core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";

export async function serve(port = 3000): Promise<void> {
  await ensurePortAvailable(port);

  const app = createApp();

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, HOST, () => {
      console.log(`listening on http://localhost:${port}`);
      resolve();
    });
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Use --port to pick another.`));
        return;
      }
      reject(error);
    });
  });
}

export function createApp(): express.Express {
  const app = express();
  const staticDir = getStaticDir();

  app.get("/api/data", async (req, res, next) => {
    try {
      const filters: DataFilters = {
        days: parseNumber(req.query.days),
        months: parseNumber(req.query.months),
        project: asOptionalString(req.query.project),
        machine: asOptionalString(req.query.machine),
      };
      const data = await aggregateData(filters);
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/session/:machineId/:source/:id/messages", async (req, res, next) => {
    try {
      const session = await findSession(req.params.machineId, req.params.source, req.params.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const sourcePath = await resolveSourcePath(session);
      if (!sourcePath) {
        const payload: SessionMessages = { sessionId: session.id, source: session.source, supported: false, messages: [] };
        res.json(payload);
        return;
      }

      try {
        await fs.access(sourcePath);
      } catch {
        const payload: SessionMessages = {
          sessionId: session.id,
          source: session.source,
          supported: true,
          messages: [],
          error: "Source file no longer available",
        };
        res.json(payload);
        return;
      }

      const parser = session.source === "eureka"
        ? parseEurekaMessagesDetailed
        : session.source === "codex"
          ? parseCodexMessagesDetailed
          : parseClaudeCodeMessagesDetailed;
      const result = await parser(sourcePath);
      const payload: SessionMessages = {
        sessionId: session.id,
        source: session.source,
        supported: true,
        messages: result.messages,
        error: result.hadParseErrors ? "Some messages could not be parsed" : undefined,
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(staticDir));
  app.get(/.*/, async (_req, res, next) => {
    try {
      await fs.access(path.join(staticDir, "index.html"));
      res.sendFile(path.join(staticDir, "index.html"));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  });

  return app;
}

function getStaticDir(): string {
  const isCompiledDist = __dirname.includes("/dist/");
  return isCompiledDist
    ? path.resolve(__dirname, "../../web")
    : path.resolve(__dirname, "../../dist/web");
}

async function findSession(machineId: string, source: string, id: string): Promise<Session | null> {
  const sessionKey = `${machineId}:${source}:${id}`;
  const localMachineId = await getMachineId();
  const localData = await loadMachineData(localMachineId);
  if (localData.sessions[sessionKey]) {
    return localData.sessions[sessionKey];
  }

  const remoteSessions = await loadRemoteSessions();
  return remoteSessions.find((session) => session.machineId === machineId && session.source === source && session.id === id) ?? null;
}

async function loadRemoteSessions(): Promise<Session[]> {
  const remoteDir = getRemoteMachinesDirectory();
  const files = await fs.readdir(remoteDir).catch(() => []);
  const machines = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => loadMachineDataFromPathSafe(path.join(remoteDir, file))),
  );
  return machines.flatMap((machine) => machine ? Object.values(machine.sessions) : []);
}

async function ensurePortAvailable(port: number): Promise<void> {
  if (port === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Use --port to pick another.`));
        return;
      }
      reject(error);
    });
    probe.listen(port, HOST, () => {
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
