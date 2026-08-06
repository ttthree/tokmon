import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestVersion, getUpdateRegistry, isUpdateCheckDisabled } from "../../src/core/version.js";

describe("version update configuration", () => {
  afterEach(() => {
    delete process.env.TOKMON_DISABLE_UPDATE_CHECK;
    delete process.env.TOKMON_NPM_REGISTRY;
    delete process.env.npm_config_registry;
    delete process.env.NPM_CONFIG_REGISTRY;
    vi.restoreAllMocks();
  });

  it("can disable update checks for network-restricted environments", async () => {
    process.env.TOKMON_DISABLE_UPDATE_CHECK = "1";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(isUpdateCheckDisabled()).toBe(true);
    await expect(fetchLatestVersion()).rejects.toThrow("update check disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prefers the tokmon registry override and trims trailing slashes", () => {
    process.env.TOKMON_NPM_REGISTRY = "https://artifacts.example/npm///";
    process.env.npm_config_registry = "https://ignored.example";
    expect(getUpdateRegistry()).toBe("https://artifacts.example/npm");
  });

  it("honors the registry environment passed through by npm", () => {
    process.env.npm_config_registry = "https://artifacts.example/npm/";
    expect(getUpdateRegistry()).toBe("https://artifacts.example/npm");
  });
});
