#!/usr/bin/env -S node --max-old-space-size=8192
import { Command } from "commander";

import { collectCommand } from "./commands/collect.js";
import { configAddProjectCommand, configExcludeFolderCommand, configSetCommand, configShowCommand } from "./commands/config.js";
import { registerCorpusCommands } from "./commands/corpus/index.js";
import { run } from "./commands/run.js";
import { serveCommand } from "./commands/serve.js";
import { isSyncConfigured, loadConfig } from "../core/config.js";
import { getPackageVersion } from "../core/version.js";
import { sync, syncInit } from "../sync/github.js";

interface RunCliOptions {
  port: number;
  open: boolean;
  reset: boolean;
}

const program = new Command();

program.name("tokmon").description("Token usage monitor for AI coding agents").version(getPackageVersion());

program
  .option("--port <port>", "Dashboard port", Number, 3000)
  .option("--no-open", "Don't auto-open browser")
  .option("--reset", "Reprocess all sessions from scratch")
  .action(async (options: RunCliOptions) => {
    const explicitPort = process.argv.includes("--port");
    await run({ ...options, explicitPort });
  });

program
  .command("collect", { hidden: true })
  .description("Collect and enrich session data")
  .option("--reset", "Reprocess all source data from scratch")
  .action(async (options: { reset?: boolean }) => {
    const result = await collectCommand(options);
    const prefix = options.reset ? "reset complete," : "incremental update complete,";
    console.log(`${prefix} ${result.sessionCount} sessions collected`);
  });

program
  .command("serve", { hidden: true })
  .description("Serve the local dashboard")
  .option("--port <port>", "Port to bind", (value) => Number(value), 3000)
  .action(async (options: { port: number }) => {
    await serveCommand(options.port);
  });

const config = program.command("config").description("Inspect or modify configuration");

config.action(async () => {
  await configShowCommand();
});

config
  .command("set")
  .argument("<key>")
  .argument("<value>")
  .action(async (key: string, value: string) => {
    await configSetCommand(key, value);
  });

config
  .command("add-project")
  .argument("<name>")
  .argument("<folder>")
  .action(async (name: string, folder: string) => {
    await configAddProjectCommand(name, folder);
  });

config
  .command("exclude-folder")
  .argument("<pattern>")
  .action(async (pattern: string) => {
    await configExcludeFolderCommand(pattern);
  });

program
  .command("sync", { hidden: true })
  .description("Sync machine data with GitHub")
  .option("--init", "Initialize GitHub sync")
  .action(async (options: { init?: boolean }) => {
    if (options.init) {
      await syncInit();
      return;
    }

    const config = await loadConfig();
    if (!isSyncConfigured(config)) {
      console.log("GitHub sync is not configured. Set config github.repo before syncing.");
      return;
    }

    await collectCommand();
    const result = await sync();
    console.log(`Sync complete: pulled ${result.pulled} remote machine files, pushed=${result.pushed}`);
  });

registerCorpusCommands(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
