import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/** Read the current package version from package.json (build-time stable). */
export function getPackageVersion(): string {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Walk upward until we find a package.json named "@ttthree/tokmon".
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@ttthree/tokmon" && pkg.version) {
          cached = pkg.version;
          return cached;
        }
      } catch {
        // ignore and keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = "0.0.0";
  return cached;
}

export const PACKAGE_NAME = "@ttthree/tokmon";

interface CachedLatest {
  version: string;
  fetchedAt: number;
}

let latestCache: CachedLatest | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Fetch the latest published version from the npm registry, with 5-min cache. */
export async function fetchLatestVersion(): Promise<string> {
  const now = Date.now();
  if (latestCache && now - latestCache.fetchedAt < CACHE_TTL_MS) {
    return latestCache.version;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`registry returned ${res.status}`);
    const json = (await res.json()) as { version?: string };
    if (!json.version) throw new Error("no version in registry response");
    latestCache = { version: json.version, fetchedAt: now };
    return json.version;
  } finally {
    clearTimeout(timer);
  }
}

/** Compare two semver-ish strings (major.minor.patch[-pre]). Returns >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core] = v.split("-");
    return core.split(".").map((p) => Number.parseInt(p, 10) || 0);
  };
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
