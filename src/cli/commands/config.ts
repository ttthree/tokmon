import { loadConfig, saveConfig, setConfigValue } from "../../core/config.js";

export async function configShowCommand(): Promise<void> {
  const config = await loadConfig();
  console.log(JSON.stringify(config, null, 2));
}

export async function configSetCommand(keyPath: string, value: string): Promise<void> {
  const parsed = parseConfigValue(value);
  const config = await setConfigValue(keyPath, parsed);
  await saveConfig(config);
  console.log(`Updated ${keyPath}`);
}

export async function configAddProjectCommand(name: string, folder: string): Promise<void> {
  const config = await loadConfig();
  const existing = config.projects[name] ?? { folders: [] };
  existing.folders = [...new Set([...existing.folders, folder])];
  config.projects[name] = existing;
  await saveConfig(config);
  console.log(`Added project mapping ${name} -> ${folder}`);
}

export async function configExcludeFolderCommand(pattern: string): Promise<void> {
  const config = await loadConfig();
  config.excludeFolders = [...new Set([...config.excludeFolders, pattern])];
  await saveConfig(config);
  console.log(`Added exclude pattern ${pattern}`);
}

function parseConfigValue(value: string): string | number | boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && value.trim() !== "") {
    return numeric;
  }
  return value;
}
