export type MessageRole = "user" | "assistant";

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: string;
  toolUseId?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId?: string;
  name?: string;
  output: string;
  isError: boolean;
}

export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock | ToolResultBlock;

export interface ConversationMessage {
  role: MessageRole;
  blocks: ContentBlock[];
  timestamp?: string;
  model?: string;
  tokens?: { input: number; output: number };
}

export interface SessionMessages {
  sessionId: string;
  source: string;
  messages: ConversationMessage[];
  supported: boolean;
  error?: string;
}

export interface ParsedMessagesResult {
  messages: ConversationMessage[];
  hadParseErrors: boolean;
}
