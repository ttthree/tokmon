import type { Parser } from "../core/types.js";

import { claudeCodeParser } from "./claude-code.js";
import { codexParser } from "./codex.js";
import { copilotCliParser } from "./copilot-cli.js";

export const sdkParsers: Parser[] = [claudeCodeParser, codexParser, copilotCliParser];
