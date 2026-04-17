import Markdown from "react-markdown";

interface ChatBubbleProps {
  role: "user" | "assistant";
  children: string;
  testId?: string;
}

export function ChatBubble({ role, children, testId }: ChatBubbleProps) {
  const isUser = role === "user";

  return (
    <div className={isUser ? "flex justify-end" : ""}>
      <div
        data-testid={testId}
        className={["rounded-2xl border px-5 py-4 text-sm leading-7", isUser ? "max-w-[85%]" : ""].join(" ")}
        style={{
          background: isUser ? "var(--bubble-user-bg)" : "var(--bubble-assistant-bg)",
          color: isUser ? "var(--bubble-user-fg)" : "var(--bubble-assistant-fg)",
          borderColor: "var(--border)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        {isUser ? children : <MarkdownContent text={children} />}
      </div>
    </div>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="tm-prose max-w-none">
      <Markdown>{text}</Markdown>
    </div>
  );
}
