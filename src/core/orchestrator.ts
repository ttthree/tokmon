import type { Source } from "./types.js";

export function inferUnderlyingSource(runtimeProvider?: string, engine?: string): Source {
  const runtime = (runtimeProvider ?? "").toLowerCase();
  const normalizedEngine = (engine ?? "").toLowerCase();

  if (runtime === "pi" || runtime.includes("pi_coding") || runtime.includes("pi-agent") || normalizedEngine === "pi" || normalizedEngine === "eureka + pi" || normalizedEngine.includes("pi agent")) return "pi-agent";
  if (runtime.includes("copilot") || normalizedEngine.includes("copilot")) return "copilot-cli";
  if (normalizedEngine.includes("codex") || runtime.includes("codex")) return "codex";
  return "claude-code";
}

export function inferSourceFromEngine(engine?: string): Source {
  return inferUnderlyingSource(undefined, engine);
}
