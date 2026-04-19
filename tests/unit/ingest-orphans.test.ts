import { describe, expect, it } from "vitest";

import { ingestEurekaOrphans } from "../../src/core/attribute.js";
import { makeEurekaCompositeKey, type EurekaIndex, type EurekaIndexEntry } from "../../src/parsers/eureka-index.js";

describe("ingestEurekaOrphans", () => {
  it("emits unknown-model zero-token orphan when header and telemetry are absent", async () => {
    const entry = makeEntry({
      eurekaSessionId: "orphan-none",
      underlyingSource: "claude-code",
      headerModel: undefined,
      telemetryTokens: undefined,
      telemetryProvenance: undefined,
    });

    const [session] = await ingestEurekaOrphans(makeIndex([entry]), new Set(), "machine-1");

    expect(session.source).toBe("claude-code");
    expect(session.model).toBe("unknown");
    expect(session.tokens).toEqual({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
    expect(session.tokenProvenance).toBe("none");
  });

  it("uses telemetry totals and underlying source when present", async () => {
    const entry = makeEntry({
      eurekaSessionId: "orphan-telemetry",
      underlyingSource: "copilot-cli",
      telemetryTokens: { input: 50, output: 12, cacheCreation: 4, cacheRead: 10 },
      telemetryProvenance: "telemetry",
    });

    const [session] = await ingestEurekaOrphans(makeIndex([entry]), new Set(), "machine-1");

    expect(session.source).toBe("copilot-cli");
    expect(session.model).toBe("gpt-4.1");
    expect(session.tokens).toEqual({ input: 50, output: 12, cacheCreation: 4, cacheRead: 10 });
    expect(session.tokenProvenance).toBe("telemetry");
  });

  it("skips entries already matched in Phase 3", async () => {
    const skipped = makeEntry({ eurekaSessionId: "skip-me" });
    const kept = makeEntry({ eurekaSessionId: "keep-me", compositeKey: "keep-key" });

    const sessions = await ingestEurekaOrphans(makeIndex([skipped, kept]), new Set([skipped.compositeKey]), "machine-1");

    expect(sessions.map((session) => session.id)).toEqual(["keep-me"]);
  });
});

function makeIndex(entries: EurekaIndexEntry[]): EurekaIndex {
  const byCompositeKey = new Map(entries.map((entry) => [entry.compositeKey, entry]));
  const bySdkSessionId = new Map<string, EurekaIndexEntry[]>();
  return {
    byCompositeKey,
    bySdkSessionId,
    lookup() {
      return undefined;
    },
  };
}

function makeEntry(overrides: Partial<EurekaIndexEntry> & Pick<EurekaIndexEntry, "eurekaSessionId">): EurekaIndexEntry {
  const compositeKey = overrides.compositeKey ?? makeEurekaCompositeKey(undefined, undefined, overrides.eurekaSessionId);
  const hasHeaderModel = Object.prototype.hasOwnProperty.call(overrides, "headerModel");
  return {
    compositeKey,
    eurekaSessionId: overrides.eurekaSessionId,
    workspaceId: overrides.workspaceId ?? "workspace-1",
    underlyingSource: overrides.underlyingSource ?? "codex",
    sdkSessionId: overrides.sdkSessionId,
    sdkCwd: overrides.sdkCwd,
    headerModel: hasHeaderModel ? overrides.headerModel : "gpt-4.1",
    telemetryTokens: overrides.telemetryTokens,
    telemetryProvenance: overrides.telemetryProvenance,
    workspacePath: overrides.workspacePath ?? "/tmp/workspace",
    workingDirectory: overrides.workingDirectory ?? "/tmp/workspace",
    engine: overrides.engine,
    runtimeProvider: overrides.runtimeProvider,
    firstTimestamp: overrides.firstTimestamp ?? "2026-04-18T12:00:00.000Z",
    lastTimestamp: overrides.lastTimestamp ?? "2026-04-18T12:05:00.000Z",
    eventTimestampsMs: overrides.eventTimestampsMs ?? [],
    name: overrides.name,
    sessionType: overrides.sessionType,
    messageCount: overrides.messageCount,
    userTurns: overrides.userTurns,
    sessionPath: overrides.sessionPath ?? "/tmp/eureka/session",
  };
}
