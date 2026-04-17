import fs from "node:fs/promises";

import type { ContentBlock, ConversationMessage, ParsedMessagesResult, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from "./messages.js";

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  is_error?: boolean;
  isError?: boolean;
  tool_use_id?: string;
  toolUseId?: string;
}

interface RawEnvelope {
  type?: string;
  timestamp?: string;
  model?: string;
  usage?: RawUsage;
  content?: RawContentBlock[];
  message?: {
    role?: string;
    model?: string;
    usage?: RawUsage;
    content?: RawContentBlock[];
  };
}

const TOOL_TEXT_LIMIT = 500;
const THINKING_TEXT_LIMIT = 2000;

// Eureka session.jsonl line shape
interface EurekaLine {
  type?: string;
  content?: string;
  timestamp?: number;
  isIntermediate?: boolean;
  turnId?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolStatus?: string;
  isError?: boolean;
}

export async function parseClaudeCodeMessages(filePath: string): Promise<ConversationMessage[]> {
  const result = await parseClaudeCodeMessagesDetailed(filePath);
  return result.messages;
}

export async function parseClaudeCodeMessagesDetailed(filePath: string): Promise<ParsedMessagesResult> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const messages: ConversationMessage[] = [];
  let hadParseErrors = false;

  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (!parsed) {
      hadParseErrors = true;
      continue;
    }

    const message = normalizeEnvelope(parsed);
    if (message) {
      messages.push(message);
    }
  }

  return { messages, hadParseErrors };
}

export async function parseEurekaMessagesDetailed(filePath: string): Promise<ParsedMessagesResult> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const messages: ConversationMessage[] = [];
  let hadParseErrors = false;

  for (const line of lines) {
    let parsed: EurekaLine;
    try {
      parsed = JSON.parse(line) as EurekaLine;
    } catch {
      hadParseErrors = true;
      continue;
    }

    const message = normalizeEurekaLine(parsed);
    if (message) {
      messages.push(message);
    }
  }

  return { messages, hadParseErrors };
}

function normalizeEurekaLine(line: EurekaLine): ConversationMessage | null {
  const timestamp = line.timestamp ? new Date(line.timestamp).toISOString() : undefined;

  if (line.type === "user") {
    const text = typeof line.content === "string" ? line.content.trim() : "";
    if (!text) return null;
    return { role: "user", blocks: [{ type: "text", text }], timestamp };
  }

  if (line.type === "assistant") {
    const text = typeof line.content === "string" ? line.content.trim() : "";
    if (!text) return null;
    if (line.isIntermediate) {
      // Intermediate assistant messages → thinking blocks (collapsed by default)
      return { role: "assistant", blocks: [{ type: "thinking", text: truncate(text, THINKING_TEXT_LIMIT) }], timestamp };
    }
    return { role: "assistant", blocks: [{ type: "text", text }], timestamp };
  }

  if (line.type === "tool") {
    const name = line.toolName ?? "Tool";
    const input = truncate(stringifyValue(line.toolInput), TOOL_TEXT_LIMIT);
    const output = truncate(typeof line.content === "string" ? line.content : stringifyValue(line.toolResult ?? line.content), TOOL_TEXT_LIMIT);
    return {
      role: "assistant",
      blocks: [{
        type: "tool_result",
        toolUseId: stringOrUndefined(line.toolUseId),
        name,
        output,
        isError: Boolean(line.isError),
      }],
      timestamp,
    };
  }

  return null;
}

function normalizeEnvelope(envelope: RawEnvelope): ConversationMessage | null {
  const type = envelope.type ?? envelope.message?.role;
  const content = envelope.message?.content ?? envelope.content ?? [];

  if (type === "user") {
    return normalizeUserMessage(envelope, content);
  }

  if (type === "assistant") {
    return normalizeAssistantMessage(envelope, content);
  }

  return null;
}

function normalizeUserMessage(envelope: RawEnvelope, content: RawContentBlock[]): ConversationMessage | null {
  const textBlocks = content.flatMap(toTextBlock);
  const toolResultBlocks = content.flatMap(toToolResultBlock);

  if (textBlocks.length > 0 && toolResultBlocks.length === 0) {
    return {
      role: "user",
      blocks: textBlocks,
      timestamp: envelope.timestamp,
      tokens: toTokenSummary(envelope),
    };
  }

  if (toolResultBlocks.length > 0 && textBlocks.length === 0) {
    return {
      role: "assistant",
      blocks: toolResultBlocks,
      timestamp: envelope.timestamp,
      tokens: toTokenSummary(envelope),
    };
  }

  return null;
}

function normalizeAssistantMessage(envelope: RawEnvelope, content: RawContentBlock[]): ConversationMessage | null {
  const blocks = content.flatMap(toAssistantBlock);
  if (blocks.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    blocks,
    timestamp: envelope.timestamp,
    model: envelope.message?.model ?? envelope.model,
    tokens: toTokenSummary(envelope),
  };
}

function toAssistantBlock(block: RawContentBlock): ContentBlock[] {
  if (block.type === "text" || block.type === undefined) {
    return toTextBlock(block);
  }

  if (block.type === "thinking") {
    return toThinkingBlock(block);
  }

  if (block.type === "tool_use") {
    return toToolUseBlock(block);
  }

  return [];
}

function toTextBlock(block: RawContentBlock): TextBlock[] {
  const text = typeof block.text === "string" ? block.text.trim() : "";
  return text ? [{ type: "text", text }] : [];
}

function toThinkingBlock(block: RawContentBlock): ThinkingBlock[] {
  const text = typeof block.thinking === "string"
    ? block.thinking.trim()
    : typeof block.text === "string"
      ? block.text.trim()
      : "";
  return text ? [{ type: "thinking", text: truncate(text, THINKING_TEXT_LIMIT) }] : [];
}

function toToolUseBlock(block: RawContentBlock): ToolUseBlock[] {
  const name = typeof block.name === "string" ? block.name.trim() : "";
  if (!name) {
    return [];
  }

  return [{
    type: "tool_use",
    name,
    input: truncate(stringifyValue(block.input), TOOL_TEXT_LIMIT),
    toolUseId: stringOrUndefined(block.tool_use_id ?? block.toolUseId),
  }];
}

function toToolResultBlock(block: RawContentBlock): ToolResultBlock[] {
  if (block.type !== "tool_result") {
    return [];
  }

  return [{
    type: "tool_result",
    toolUseId: stringOrUndefined(block.tool_use_id ?? block.toolUseId),
    name: stringOrUndefined(block.name),
    output: truncate(stringifyValue(block.output ?? block.content), TOOL_TEXT_LIMIT),
    isError: Boolean(block.is_error ?? block.isError),
  }];
}

function toTokenSummary(envelope: RawEnvelope): { input: number; output: number } | undefined {
  const usage = envelope.message?.usage ?? envelope.usage;
  const input = numberOrZero(usage?.input_tokens);
  const output = numberOrZero(usage?.output_tokens);
  return input > 0 || output > 0 ? { input, output } : undefined;
}

function parseJsonLine(line: string): RawEnvelope | null {
  try {
    return JSON.parse(line) as RawEnvelope;
  } catch {
    return null;
  }
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
