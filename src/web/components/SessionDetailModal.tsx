import { useEffect, useMemo, useRef, useState } from "react";

import type { ContentBlock, ConversationMessage, ToolResultBlock, ToolUseBlock } from "../../core/messages.js";
import type { Session } from "../../core/types.js";
import { fetchSessionMessages } from "../api.js";
import { ChatBubble } from "./ChatBubble.js";

interface SessionDetailModalProps {
  session: Session;
  onClose: () => void;
  formatCurrency: (value: number) => string;
}

interface StepItem {
  tone: "thinking" | "tool";
  summary: string;
  detail: string;
}

type RenderItem =
  | { type: "bubble"; role: "user" | "assistant"; text: string }
  | { type: "group"; steps: StepItem[]; testId?: string };

export function SessionDetailModal({ session, onClose, formatCurrency }: SessionDetailModalProps) {
  const [state, setState] = useState<{ loading: boolean; supported: boolean; error?: string; messages: ConversationMessage[] }>({
    loading: true,
    supported: true,
    messages: [],
  });
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    setState({ loading: true, supported: true, messages: [] });
    fetchSessionMessages(session.machineId, session.source, session.id)
      .then((result) => {
        if (!active) return;
        setState({ loading: false, supported: result.supported, error: result.error, messages: result.messages });
      })
      .catch((error: Error) => {
        if (!active) return;
        setState({ loading: false, supported: true, error: error.message, messages: [] });
      });
    return () => {
      active = false;
    };
  }, [session.id, session.machineId, session.source]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const container = modalRef.current;
      if (!container) {
        return;
      }
      const focusables = Array.from(container.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.hasAttribute("disabled"));
      if (focusables.length === 0) {
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const renderItems = useMemo(() => buildRenderItems(state.messages), [state.messages]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/40 p-2 sm:p-3" onClick={onClose}>
      <div
        ref={modalRef}
        data-testid="session-modal"
        role="dialog"
        aria-modal="true"
        className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">{session.project} · {session.source} · {session.model} · {formatCurrency(session.cost.total)}</div>
            <div className="mt-1 text-xs text-slate-500">{formatDate(session.createdAt)} · {formatDuration(session.durationSeconds)} · {session.turns} turns</div>
          </div>
          <button ref={closeButtonRef} type="button" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600" onClick={onClose}>Close</button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto flex max-w-4xl flex-col gap-5">
            {state.loading ? <div className="text-sm text-slate-500">Loading conversation…</div> : null}
            {!state.loading && !state.supported ? <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">Conversation replay not available for {session.source} sessions.</div> : null}
            {!state.loading && state.supported && state.error && state.messages.length === 0 ? <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">{state.error}</div> : null}
            {!state.loading && state.supported ? renderItems.map((item, index) => (
              item.type === "bubble"
                ? <ChatBubble key={`b-${index}`} role={item.role} testId={item.role === "user" ? "user-bubble" : "assistant-bubble"}>{item.text}</ChatBubble>
                : <StepGroup key={`g-${index}`} steps={item.steps} testId={item.testId} />
            )) : null}
          </div>
        </div>
        <footer className="border-t border-slate-200 bg-white px-6 py-3 text-xs text-slate-600">
          Input: {formatNumber(session.tokens.input)} · Output: {formatNumber(session.tokens.output)} · Cache: {formatNumber(session.tokens.cacheCreation + session.tokens.cacheRead)} · Tools: {session.toolCallCount}
        </footer>
      </div>
    </div>
  );
}

function StepGroup({ steps, testId }: { steps: StepItem[]; testId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const thinkingCount = steps.filter((s) => s.tone === "thinking").length;
  const toolCount = steps.filter((s) => s.tone === "tool").length;
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`${thinkingCount} thinking`);
  if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount > 1 ? "s" : ""}`);
  const label = parts.join(", ");

  return (
    <div data-testid={testId} className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/80 shadow-sm">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left text-xs font-medium text-slate-500"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>{expanded ? "▼" : "▶"} {label}</span>
        <span className="text-xs text-slate-400">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-px border-t border-slate-200 bg-slate-200">
          {steps.map((step, index) => (
            <StepRow key={index} step={step} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ step }: { step: StepItem }) {
  const [expanded, setExpanded] = useState(false);
  const icon = step.tone === "thinking" ? "💭" : "🔧";

  return (
    <div className="bg-white">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{step.summary}</span>
        <span className="shrink-0 text-slate-400">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded ? (
        <div className="border-t border-slate-100 px-4 py-3">
          <pre className="whitespace-pre-wrap break-words text-xs font-mono text-slate-700">{step.detail}</pre>
        </div>
      ) : null}
    </div>
  );
}

function buildRenderItems(messages: ConversationMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  const consumedToolResults = new Set<string>();
  let pendingSteps: StepItem[] = [];

  const flushSteps = () => {
    if (pendingSteps.length === 0) return;
    const hasThinking = pendingSteps.some((s) => s.tone === "thinking");
    items.push({ type: "group", steps: pendingSteps, testId: hasThinking ? "thinking-block" : undefined });
    pendingSteps = [];
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      flushSteps();
      const text = message.blocks.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text").map((block) => block.text).join("\n\n");
      if (text) items.push({ type: "bubble", role: "user", text });
      continue;
    }

    // Tool result messages (from Claude Code format)
    if (message.blocks.every((block) => block.type === "tool_result")) {
      const toolResults = message.blocks as ToolResultBlock[];
      for (let toolResultIndex = 0; toolResultIndex < toolResults.length; toolResultIndex += 1) {
        const result = toolResults[toolResultIndex];
        const key = `${index}:${toolResultIndex}`;
        if (consumedToolResults.has(key)) continue;
        const name = result.name ?? "Result";
        const status = result.isError ? "error" : "done";
        pendingSteps.push({
          tone: "tool",
          summary: `${name} → ${status}`,
          detail: formatToolContent(undefined, result),
        });
      }
      continue;
    }

    // Pure text assistant message — final response bubble
    const hasText = message.blocks.some((b) => b.type === "text");
    const hasNonText = message.blocks.some((b) => b.type !== "text");

    if (hasText && !hasNonText) {
      flushSteps();
      const text = message.blocks.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n\n");
      if (text) items.push({ type: "bubble", role: "assistant", text });
      continue;
    }

    // Mixed blocks — process each
    const pendingText: string[] = [];
    const flushAssistantText = () => {
      if (pendingText.length === 0) return;
      flushSteps();
      items.push({ type: "bubble", role: "assistant", text: pendingText.join("\n\n") });
      pendingText.length = 0;
    };

    for (const block of message.blocks) {
      if (block.type === "text") {
        pendingText.push(block.text);
      } else if (block.type === "thinking") {
        flushAssistantText();
        pendingSteps.push({
          tone: "thinking",
          summary: truncateOneLine(block.text, 120),
          detail: block.text,
        });
      } else if (block.type === "tool_use") {
        flushAssistantText();
        const pairedResult = takePairedToolResult(messages, index + 1, block, consumedToolResults);
        const status = pairedResult ? (pairedResult.isError ? "error" : "done") : "pending";
        pendingSteps.push({
          tone: "tool",
          summary: `${block.name} → ${status}`,
          detail: formatToolContent(block, pairedResult),
        });
      }
    }

    if (pendingText.length > 0) {
      flushSteps();
      items.push({ type: "bubble", role: "assistant", text: pendingText.join("\n\n") });
      pendingText.length = 0;
    }
  }

  flushSteps();
  return items;
}

function takePairedToolResult(messages: ConversationMessage[], index: number, block: ToolUseBlock, consumedToolResults: Set<string>): ToolResultBlock | undefined {
  const message = messages[index];
  if (!message || !message.blocks.every((candidate) => candidate.type === "tool_result")) {
    return undefined;
  }

  const toolResults = message.blocks as ToolResultBlock[];
  const preferred = toolResults.findIndex((candidate, toolResultIndex) => !consumedToolResults.has(`${index}:${toolResultIndex}`) && block.toolUseId && candidate.toolUseId === block.toolUseId);
  const fallback = toolResults.findIndex((_candidate, toolResultIndex) => !consumedToolResults.has(`${index}:${toolResultIndex}`));
  const selectedIndex = preferred >= 0 ? preferred : fallback;
  if (selectedIndex < 0) {
    return undefined;
  }

  consumedToolResults.add(`${index}:${selectedIndex}`);
  return toolResults[selectedIndex];
}

function formatToolContent(toolUse?: ToolUseBlock, toolResult?: ToolResultBlock): string {
  const input = toolUse?.input || "(none)";
  const output = toolResult?.output || "(pending)";
  return `Input\n${input}\n\nOutput\n${output}`;
}

function truncateOneLine(text: string, maxLength: number): string {
  const line = text.replace(/\n/g, " ").trim();
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
