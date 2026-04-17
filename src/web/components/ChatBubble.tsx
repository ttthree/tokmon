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
        className={[
          "rounded-2xl border px-5 py-4 text-sm leading-7 shadow-sm",
          isUser ? "max-w-[85%] border-blue-100 bg-blue-50 text-slate-900" : "border-slate-200 bg-white text-slate-900",
        ].join(" ")}
      >
        {isUser ? children : <MarkdownContent text={children} />}
      </div>
    </div>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-slate max-w-none prose-headings:mt-4 prose-headings:mb-2 prose-headings:text-slate-900 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:bg-slate-50 prose-pre:border prose-pre:border-slate-200 prose-pre:rounded-xl prose-code:text-xs prose-code:before:content-none prose-code:after:content-none prose-a:text-blue-600 prose-blockquote:border-slate-300 prose-blockquote:text-slate-600 prose-hr:border-slate-200 prose-table:text-xs">
      <Markdown>{text}</Markdown>
    </div>
  );
}
