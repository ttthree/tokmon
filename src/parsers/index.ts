import type { Parser } from "../core/types.js";

import { claudeCodeParser } from "./claude-code.js";
import { codexParser } from "./codex.js";
import { copilotCliParser } from "./copilot-cli.js";
import { eurekaParser } from "./eureka.js";
import { marsParser } from "./mars.js";

// Eureka MUST run before claudeCode so claimedCcSessionIds is populated
// before CC parser scans ~/.craft-agent/.claude/
export const parsers: Parser[] = [marsParser, eurekaParser, claudeCodeParser, codexParser, copilotCliParser];
