# tokmon Session Detail Modal — Implementation Design

## Goal

Add a full-screen modal that opens when a user clicks a session row. The modal shows the session's conversation in a Codex-style chat bubble UI: user messages and assistant final responses as bubbles, with thinking steps and tool calls collapsed by default.

## Scope

### In scope

- Add server-only source path resolution to re-read raw conversation files on demand
- Add backend API `GET /api/session/:machineId/:source/:id/messages` that re-reads the source file and returns structured conversation messages
- Add a message parser that extracts user prompts, assistant text, thinking blocks, and tool calls from Claude Code `.jsonl` files
- Add a full-screen modal component (`SessionDetailModal`) with:
  - Header: project, model, source, date, duration, cost (sticky top)
  - Chat bubble area: user messages (right-aligned), assistant messages (left-aligned)
  - Collapsible thinking/tool-call sections between bubbles
  - Sticky footer bar: token breakdown summary (input/output/cache/tools count)
- Make session table rows clickable to open the modal
- Add `selectedSession` state to `App.tsx`
- Support keyboard dismiss (Escape key)

### Out of scope

- Codex message parsing (Codex SQLite doesn't store message content in the threads table)
- Eureka full conversation replay (session.jsonl format is different)
- Review tags, comparison mode, related sessions
- URL state / deep linking
- Editing or annotating sessions

## Data changes

### 1. Source path resolution (server-only, NOT on Session type)

`sourcePath` is **not** added to the `Session` interface in `types.ts`. The `Session` type is shared across frontend, API responses, and sync payloads — adding filesystem paths would leak sensitive local paths to the browser and to synced remote data.

Instead, source paths are resolved **on-demand server-side** when the messages endpoint is called:

**New file: `src/core/source-resolver.ts`**

```typescript
export function resolveSourcePath(session: Session): string | null
```

For claude-code sessions: reconstruct the path as `~/.claude/projects/{encodedProjectPath}/{sessionId}.jsonl` using the `session.projectPath` and `session.id` fields already on the Session.

For eureka / codex / copilot-cli: return `null` (not supported). Eureka session data does not store enough info to reliably reconstruct the workspace path, and Codex/Copilot don't have raw conversation files.

This keeps source path logic entirely server-side. The frontend never sees filesystem paths.

### 2. Conversation message types and render model

**New file: `src/core/messages.ts`**

The API returns a flat array of `ConversationMessage` objects. The frontend renders them top-to-bottom in order. Each message maps to exactly one visual element:

#### Render model

The raw Claude Code `.jsonl` contains interleaved user/assistant/tool messages. The parser normalizes these into a **render stream** — a flat list of `ConversationMessage` objects where each entry maps to exactly one visual element in the UI.

**Normalization rules:**

1. A `type: "user"` line whose `content` contains only `text` blocks → one `ConversationMessage { role: "user", blocks: [TextBlock, ...] }` → renders as a **right-aligned user bubble**.

2. A `type: "user"` line whose `content` contains only `tool_result` blocks → one `ConversationMessage { role: "assistant", blocks: [ToolResultBlock, ...] }` → renders as a **collapsible tool result block** (left side, collapsed). These are attributed to `role: "assistant"` in the render stream because they are tool execution results, not user-authored text.

3. A `type: "assistant"` line → one `ConversationMessage { role: "assistant", blocks: [...] }`. The `blocks` array preserves the order of content blocks from the source: `text`, `thinking`, `tool_use` can appear in any mix. The frontend handles each block type:
   - `TextBlock` → rendered as visible assistant text in a bubble
   - `ThinkingBlock` → rendered as a collapsible "Thinking..." section
   - `ToolUseBlock` → rendered as a collapsible "Tool: {name}" section

4. **No merging of consecutive assistant messages.** Each `.jsonl` line produces exactly one `ConversationMessage`. This keeps the parser stateless and the render stream 1:1 with source lines.

5. **Tool pairing:** The frontend pairs `ToolUseBlock` (from an assistant message) with the immediately following `ToolResultBlock` (from the next tool_result message) for display. Pairing uses `toolUseId` if present on both sides; otherwise falls back to positional matching. If a tool_use has no following result, it renders alone. `ToolResultBlock.name` is populated from the source if available; otherwise the frontend inherits the name from the paired `ToolUseBlock`.

**Visual mapping summary:**

| Render stream entry | Visual element |
|---|---|
| `role: "user"`, blocks: text | Right-aligned user bubble |
| `role: "assistant"`, blocks: text only | Left-aligned assistant bubble |
| `role: "assistant"`, blocks: thinking + text + tool_use | Left-aligned bubble: collapsible thinking, then text, then collapsible tool calls |
| `role: "assistant"`, blocks: tool_result | Collapsible tool result (pairs with preceding tool_use) |

```typescript
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
  input: string; // JSON stringified, truncated to 500 chars
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId?: string;  // tool_use_id from source, used for frontend pairing
  name?: string;       // only present if source block contains it; frontend falls back to pairing with preceding ToolUseBlock
  output: string;      // truncated to 500 chars
  isError: boolean;
}

export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock | ToolResultBlock;

export interface ConversationMessage {
  role: MessageRole;
  blocks: ContentBlock[];
  timestamp?: string; // ISO string if extractable
  model?: string;
  tokens?: { input: number; output: number };
}

export interface SessionMessages {
  sessionId: string;
  source: string;
  messages: ConversationMessage[];
  supported: boolean;  // false if source doesn't support message extraction
  error?: string;
}
```

### 3. Message extraction from Claude Code `.jsonl`

**New file: `src/core/message-parser.ts`**

Parse the Claude Code `.jsonl` format line-by-line, producing one `ConversationMessage` per line:

- Each line is a JSON object with `type` or `message.role`
- `type: "user"` with text content → `{ role: "user", blocks: [TextBlock, ...] }`
- `type: "user"` with `tool_result` content → `{ role: "assistant", blocks: [ToolResultBlock, ...] }`
- `type: "assistant"` → `{ role: "assistant", blocks: [...] }` preserving block order (text, thinking, tool_use)

Key behavior:
- Text blocks with empty strings are skipped
- Tool input is JSON-stringified and truncated to 500 chars
- Tool result output is truncated to 500 chars
- Thinking block text is truncated to 2000 chars
- Malformed JSON lines are silently skipped
- Lines with no recognizable type/role are silently skipped
- The parser is stateless: no merging, no cross-line state

```typescript
export function parseClaudeCodeMessages(filePath: string): Promise<ConversationMessage[]>
```

### 4. Backend API

**File: `src/server/index.ts`**

Add endpoint:

```typescript
app.get("/api/session/:machineId/:source/:id/messages", async (req, res, next) => {
  // 1. Find the session in aggregated data
  // 2. Resolve source path server-side via resolveSourcePath()
  // 3. If source not supported → 200 with { supported: false }
  // 4. If file not readable → 200 with { supported: true, messages: [], error: "Source file no longer available" }
  // 5. Parse messages → 200 with { supported: true, messages: [...] }
});
```

#### HTTP response contract

All responses are JSON. The endpoint uses **200 for all expected states** (including "not supported" and "file missing") because these are not client errors — they are expected data states. Only unexpected server errors use 5xx.

| Scenario | HTTP Status | Response body |
|---|---|---|
| Session found, source supported, file readable | `200` | `{ sessionId, source, supported: true, messages: [...] }` |
| Session found, source not supported (codex/copilot) | `200` | `{ sessionId, source, supported: false, messages: [] }` |
| Session found, source supported, file missing/unreadable | `200` | `{ sessionId, source, supported: true, messages: [], error: "Source file no longer available" }` |
| Session found, source supported, parse error (malformed JSONL) | `200` | `{ sessionId, source, supported: true, messages: [...partial...], error: "Some messages could not be parsed" }` |
| Session not found in any machine data | `404` | `{ error: "Session not found" }` |
| Unexpected server error | `500` | `{ error: "<message>" }` (existing error handler) |

#### Session lookup

The endpoint needs to find a session by `machineId + source + id`. This uses the same data loading as `aggregateData()`:
1. Load local machine data
2. Load remote machine data
3. Search for session with matching key `${machineId}:${source}:${id}`

This does NOT call `aggregateData()` (which applies filters) — it loads all machine data directly to find any session regardless of time range.

## UI design

### Modal structure

Full-screen overlay with a centered content area (max-width ~900px):

```
┌──────────────────────────────────────────────────┐
│ ✕  Project Name · claude-code · model · $12.34   │  ← sticky header
│    Apr 12, 2026 · 45m · 23 turns                 │
├──────────────────────────────────────────────────┤
│                                                  │
│                      ┌────────────────────┐      │
│                      │ User message       │      │  ← right-aligned, blue-ish bg
│                      └────────────────────┘      │
│  ┌─────────────────────────┐                     │
│  │ ▶ Thinking (collapsed)  │                     │  ← muted, collapsed
│  ├─────────────────────────┤                     │
│  │ ▶ Tool: Read (1)        │                     │  ← muted, collapsed
│  ├─────────────────────────┤                     │
│  │ Assistant response text │                     │  ← left-aligned, white bg
│  └─────────────────────────┘                     │
│                      ┌────────────────────┐      │
│                      │ Next user message   │     │
│                      └────────────────────┘      │
│  ...                                             │
│                                                  │
├──────────────────────────────────────────────────┤
│ Input: 1.2M  Output: 45K  Cache: 890K  Tools: 5 │  ← sticky footer stats
└──────────────────────────────────────────────────┘
```

### Chat bubble styling

- **User messages**: right-aligned, `bg-blue-50 border-blue-100` rounded bubble, `text-slate-900`
- **Assistant text**: left-aligned, `bg-white border-slate-200` rounded bubble
- **Thinking blocks**: collapsed by default, `bg-amber-50/50 border-amber-100` with "Thinking..." label, click to expand
- **Tool use/result pairs**: collapsed by default, `bg-slate-50 border-slate-200` with tool name as label, click to expand showing input → output

### Collapsible sections

Each thinking/tool section has:
- A single-line header showing the type (thinking / tool name)
- Click toggles expand/collapse
- Chevron icon indicates state
- Default: collapsed
- Expanded: shows content in a `pre` tag with `text-xs font-mono`

### Loading and error states

- While loading messages: skeleton bubbles or spinner
- If source not supported: show session metadata only (header + token/cost breakdown), with a note "Conversation replay not available for {source} sessions"
- If file not found: show metadata only with note "Source file no longer available"

### Keyboard interaction and accessibility

- `Escape` closes the modal
- Scrolling within the modal doesn't scroll the background (use `overflow: hidden` on body while modal is open)
- Focus trap: when modal opens, focus moves to the close button. Tab cycles within the modal. On close, focus returns to the session row that triggered the modal.
- Session table rows get `role="button"` and `tabIndex={0}` with Enter/Space triggering selection
- If the selected session disappears (due to time range or filter change while modal is open), the modal closes automatically

## Component breakdown

### `src/web/components/SessionDetailModal.tsx`

Props:
```typescript
interface SessionDetailModalProps {
  session: Session;
  onClose: () => void;
  formatCurrency: (value: number) => string;
}
```

Fetches messages from `/api/session/:machineId/:source/:id/messages` on mount.

### `src/web/components/ChatBubble.tsx`

Renders a single user or assistant message bubble.

### `src/web/components/CollapsibleBlock.tsx`

Renders a collapsible thinking or tool-call block.

## Changes to existing files

| File | Change |
|------|--------|
| `src/core/messages.ts` | **New** — message types and render model types |
| `src/core/message-parser.ts` | **New** — Claude Code message parser |
| `src/core/source-resolver.ts` | **New** — resolve source file path from Session (server-only) |
| `src/server/index.ts` | Add `/api/session/:machineId/:source/:id/messages` endpoint |
| `src/web/App.tsx` | Add `selectedSession` state, pass to modal, make session table clickable |
| `src/web/components/SessionTable.tsx` | Add `onSelect` callback prop, make rows clickable with hover state and keyboard support |
| `src/web/components/SessionDetailModal.tsx` | **New** — full-screen modal |
| `src/web/components/ChatBubble.tsx` | **New** — chat bubble component |
| `src/web/components/CollapsibleBlock.tsx` | **New** — collapsible thinking/tool block |
| `src/web/api.ts` | Add `fetchSessionMessages()` function |

## Test strategy

### Unit tests

**`tests/unit/message-parser.test.ts`:**
- Parses a Claude Code `.jsonl` with user text, assistant text, thinking, and tool_use blocks
- User messages with only text → `role: "user"`
- User messages with only `tool_result` → `role: "assistant"` with ToolResultBlock
- Handles empty files → returns empty array
- Truncates long tool input/output to 500 chars
- Truncates thinking text to 2000 chars
- Handles malformed JSON lines gracefully (skips them, returns partial result)
- Handles lines with no recognizable type (skips them)
- Handles file with only user messages (no assistant)
- Handles file with only assistant messages (no user)

**`tests/unit/source-resolver.test.ts`:**
- Claude-code session with known projectPath → resolves to correct `.jsonl` path
- Codex session → returns null
- Copilot-cli session → returns null
- Session with empty projectPath → returns null

### Backend API tests

**`tests/unit/session-messages-api.test.ts`:**
- Session found + supported source + file exists → 200 with messages
- Session found + unsupported source → 200 with `supported: false`
- Session found + supported source + file missing → 200 with empty messages + error string
- Session not found → 404
- Malformed JSONL → 200 with partial messages + error string

### E2E tests

**`tests/e2e/session-detail.spec.ts`:**

The E2E test fixture must include Claude Code `.jsonl` test data with user text, assistant text, thinking blocks, and tool_use/tool_result blocks. Extend `tests/helpers/fixtures.ts` to write a sample `.jsonl` file alongside session data.

- Click a session row → modal opens with `[data-testid="session-modal"]`
- Modal shows session header with project name and cost
- Modal shows at least one user bubble and one assistant bubble
- Thinking blocks are collapsed by default (content not visible)
- Click a thinking block header → content becomes visible
- Press Escape → modal closes (verify `session-modal` is removed from DOM)
- Click backdrop → modal closes

## Non-goals

- No full transcript replay for Codex or Copilot CLI
- No message-level token attribution
- No editing/annotation
- No URL deep linking to specific sessions
- No comparison mode
