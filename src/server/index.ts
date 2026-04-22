import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { aggregateData } from "../core/aggregate.js";
import { loadMachineData } from "../core/data.js";
import {
  loadMachineDataFromPathSafe,
  getRemoteMachinesDirectory,
  loadConfig,
  saveConfig,
  detectAvailableSources,
  mergeAutoDetectedSources,
  pathExists,
} from "../core/config.js";
import { parseClaudeCodeMessagesDetailed, parseCodexMessagesDetailed, parseCopilotCliMessagesDetailed, parseEurekaMessagesDetailed } from "../core/message-parser.js";
import { getMachineId } from "../core/machine.js";
import type { SessionMessages } from "../core/messages.js";
import { resolveSourcePath } from "../core/source-resolver.js";
import type { AppConfig, DataFilters, MachineConfig, Session, SourceEntry, SourceType } from "../core/types.js";
import { collectCommand, type CollectProgressEvent } from "../cli/commands/collect.js";
import { compareVersions, fetchLatestVersion, getPackageVersion, PACKAGE_NAME } from "../core/version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";

export interface ServeOptions {
  autoFallback?: boolean;
  maxAttempts?: number;
}

export async function serve(port = 3000, options: ServeOptions = {}): Promise<number> {
  const { autoFallback = false, maxAttempts = 10 } = options;
  const attempts = autoFallback ? maxAttempts : 1;

  let lastError: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    const candidate = port + i;
    try {
      await ensurePortAvailable(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (autoFallback && i < attempts - 1) {
        console.log(`Port ${candidate} is in use; trying ${candidate + 1}...`);
        continue;
      }
      break;
    }

    const app = createApp();
    try {
      await new Promise<void>((resolve, reject) => {
        const server = app.listen(candidate, HOST, () => {
          console.log(`listening on http://localhost:${candidate}`);
          resolve();
        });
        server.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE") {
            reject(new Error(`Port ${candidate} is already in use. Use --port to pick another.`));
            return;
          }
          reject(error);
        });
      });
      return candidate;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (autoFallback && i < attempts - 1) {
        console.log(`Port ${candidate} is in use; trying ${candidate + 1}...`);
        continue;
      }
      break;
    }
  }

  throw lastError ?? new Error(`Port ${port} is already in use. Use --port to pick another.`);
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      const tag = res.statusCode >= 500 ? "ERR" : res.statusCode >= 400 ? "WRN" : "OK ";
      console.log(`[req ${tag}] ${res.statusCode} ${req.method} ${req.originalUrl} ${ms}ms`);
    });
    next();
  });
  const staticDir = getStaticDir();

  app.get("/api/data", async (req, res, next) => {
    try {
      const rawSource = asOptionalString(req.query.source);
      const legacyOrchestrator = rawSource === "eureka" || rawSource === "mars" ? rawSource : undefined;
      const filters: DataFilters = {
        days: parseNumber(req.query.days),
        months: parseNumber(req.query.months),
        project: asOptionalString(req.query.project),
        machine: asOptionalString(req.query.machine),
        orchestrator: asOptionalOrchestrator(req.query.orchestrator) ?? legacyOrchestrator,
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

      const result =
        session.source === "copilot-cli"
          ? await parseCopilotCliMessagesDetailed(sourcePath, session.id)
          : session.orchestrator?.kind === "eureka"
            ? await parseEurekaMessagesDetailed(sourcePath)
            : session.source === "codex"
              ? await parseCodexMessagesDetailed(sourcePath)
              : await parseClaudeCodeMessagesDetailed(sourcePath);
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

  app.get("/api/settings", async (_req, res, next) => {
    try {
      const config = await loadConfig();
      res.json(config);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/machine", async (_req, res, next) => {
    try {
      const [id, config] = await Promise.all([getMachineId(), loadConfig()]);
      const hostname = os.hostname();
      const name = config.machine?.name?.trim() || hostname;
      res.json({ id, hostname, name });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/version", async (_req, res) => {
    const current = getPackageVersion();
    try {
      const latest = await fetchLatestVersion();
      const updateAvailable = compareVersions(latest, current) > 0;
      res.json({
        package: PACKAGE_NAME,
        current,
        latest,
        updateAvailable,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.json({
        package: PACKAGE_NAME,
        current,
        latest: null,
        updateAvailable: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/settings", async (req, res, next) => {
    try {
      const current = await loadConfig();
      const body = (req.body ?? {}) as Partial<AppConfig>;
      const updated: AppConfig = {
        ...current,
        refresh: { ...current.refresh, ...body.refresh },
        github: { ...current.github, ...body.github },
        privacy: body.privacy ?? current.privacy,
        projects: body.projects ?? current.projects,
        excludeFolders: body.excludeFolders ?? current.excludeFolders,
        pricing: { ...current.pricing, ...body.pricing },
        sources: Array.isArray(body.sources)
          ? sanitizeSources(body.sources)
          : current.sources,
        machine: sanitizeMachine(body.machine, current.machine),
      };
      // Re-run detection to keep autoDetected entries fresh
      const detected = await detectAvailableSources();
      updated.sources = mergeAutoDetectedSources(updated.sources, detected);
      await saveConfig(updated);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sources/detect", async (_req, res, next) => {
    try {
      const detected = await detectAvailableSources();
      res.json({ sources: detected });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sources/validate", async (req, res, next) => {
    try {
      const p = typeof req.body?.path === "string" ? req.body.path : "";
      if (!p) {
        res.status(400).json({ error: "path is required" });
        return;
      }
      const exists = await pathExists(p);
      res.json({ exists });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/collect", async (req, res, next) => {
    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      const reset = Boolean(req.body?.reset);
      const send = (event: CollectProgressEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try {
        await collectCommand({ silent: true, reset, onProgress: send });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.write(`data: ${JSON.stringify({ phase: "error", message })}\n\n`);
      }
      res.end();
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

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[server] 500 on ${req.method} ${req.originalUrl}: ${message}`);
    if (stack) console.error(stack);
    res.status(500).json({ error: message });
  });

  return app;
}

function getStaticDir(): string {
  const normalized = __dirname.replace(/\\/g, "/");
  if (normalized.includes("/dist/src/")) {
    return path.resolve(__dirname, "../../web");
  }
  if (normalized.includes("/dist/")) {
    return path.resolve(__dirname, "../web");
  }
  return path.resolve(__dirname, "../../dist/web");
}

async function findSession(machineId: string, source: string, id: string): Promise<Session | null> {
  const sessionKey = `${machineId}:${source}:${id}`;
  const localMachineId = await getMachineId();
  const localData = await loadMachineData(localMachineId);
  if (localData.sessions[sessionKey]) {
    return localData.sessions[sessionKey];
  }

  if (source === "eureka") {
    const localSessions = localMachineId === machineId ? Object.values(localData.sessions) : [];
    const localMatch = localSessions.find((session) => isLegacyEurekaSession(session, machineId, id));
    if (localMatch) {
      return localMatch;
    }
  }

  const remoteSessions = await loadRemoteSessions();
  if (source === "eureka") {
    return remoteSessions.find((session) => isLegacyEurekaSession(session, machineId, id)) ?? null;
  }
  return remoteSessions.find((session) => session.machineId === machineId && session.source === source && session.id === id) ?? null;
}

function isLegacyEurekaSession(session: Session, machineId: string, id: string): boolean {
  return session.machineId === machineId && session.id === id && session.orchestrator?.kind === "eureka";
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

function asOptionalOrchestrator(value: unknown): DataFilters["orchestrator"] {
  const raw = asOptionalString(value);
  if (!raw) return undefined;
  if (raw === "mars" || raw === "eureka" || raw === "none") return raw;
  return undefined;
}

const VALID_SOURCE_TYPES = new Set<SourceType>(["claude-code", "codex", "copilot-cli", "eureka", "mars"]);

function sanitizeMachine(input: unknown, current: MachineConfig | undefined): MachineConfig | undefined {
  if (input === undefined) return current;
  if (input === null || typeof input !== "object") return current;
  const raw = input as Partial<MachineConfig>;
  const rawName = typeof raw.name === "string" ? raw.name.trim() : undefined;
  return { name: rawName && rawName.length > 0 ? rawName : undefined };
}

function sanitizeSources(input: unknown[]): SourceEntry[] {
  const result: SourceEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Partial<SourceEntry>;
    if (typeof s.type !== "string" || !VALID_SOURCE_TYPES.has(s.type)) continue;
    if (typeof s.path !== "string" || !s.path) continue;
    const id = typeof s.id === "string" && s.id ? s.id : `${s.type}:${s.path}`;
    result.push({
      id,
      type: s.type as SourceEntry["type"],
      path: s.path,
      enabled: s.enabled !== false,
      autoDetected: Boolean(s.autoDetected),
      label: typeof s.label === "string" ? s.label : undefined,
    });
  }
  return result;
}
