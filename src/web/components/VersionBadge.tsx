import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchVersionInfo, type VersionInfo } from "../api.js";

const POPOVER_WIDTH = 280;
const POPOVER_GAP = 6;
const NPM_INSTALL_CMD = "npm i -g @ttthree/tokmon@latest";

export function VersionBadge() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetchVersionInfo()
        .then((v) => {
          if (!cancelled) setInfo(v);
        })
        .catch(() => {
          // network errors are not fatal — just hide the latest portion
        });
    };
    check();
    // Re-check every 5 minutes so long-running dashboards eventually pick up
    // a new release without requiring a manual refresh.
    const interval = setInterval(check, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const btn = triggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - POPOVER_WIDTH - 8, rect.left));
      const top = rect.bottom + POPOVER_GAP;
      setPos({ top, left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  if (!info) return null;

  const updateAvailable = info.updateAvailable && info.latest;

  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText(NPM_INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          updateAvailable
            ? `New version ${info.latest} available (current ${info.current})`
            : `tokmon v${info.current}`
        }
        className="ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums transition-colors"
        style={{
          background: updateAvailable ? "var(--accent)" : "var(--badge-bg)",
          color: updateAvailable ? "var(--accent-fg)" : "var(--badge-fg)",
          border: "1px solid var(--border)",
          letterSpacing: "0.02em",
          cursor: "pointer",
        }}
      >
        <span>v{info.current}</span>
        {updateAvailable ? (
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--accent-fg)", opacity: 0.85 }}
          />
        ) : null}
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={popRef}
              role="dialog"
              aria-label="Version info"
              className="fixed overflow-hidden rounded-md border"
              style={{
                top: pos.top,
                left: pos.left,
                width: POPOVER_WIDTH,
                zIndex: 9999,
                background: "var(--bg-panel)",
                borderColor: "var(--border)",
                boxShadow: "var(--shadow-card, 0 8px 24px rgba(0,0,0,0.18))",
                color: "var(--text-primary)",
                fontFamily: "var(--font-body)",
              }}
            >
              <div
                className="px-3 py-2"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <div
                  className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}
                >
                  tokmon
                </div>
                <div className="mt-0.5 flex items-baseline gap-2">
                  <span className="text-sm font-semibold tabular-nums">v{info.current}</span>
                  {info.latest ? (
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      latest: v{info.latest}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="px-3 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
                {updateAvailable ? (
                  <>
                    <div className="mb-2">
                      A new version is available. Update with:
                    </div>
                    <div
                      className="flex items-center gap-2 rounded-md px-2 py-1.5"
                      style={{
                        background: "var(--code-bg)",
                        border: "1px solid var(--code-border)",
                        color: "var(--code-fg)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      <code className="flex-1 truncate text-[11px]">{NPM_INSTALL_CMD}</code>
                      <button
                        type="button"
                        onClick={copyCmd}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          background: "var(--accent)",
                          color: "var(--accent-fg)",
                          fontFamily: "var(--font-body)",
                        }}
                      >
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <a
                      href={`https://www.npmjs.com/package/@ttthree/tokmon/v/${info.latest}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-2 inline-block text-[11px] underline"
                      style={{ color: "var(--accent)" }}
                    >
                      View v{info.latest} on npm →
                    </a>
                  </>
                ) : info.error ? (
                  <div style={{ color: "var(--text-muted)" }}>
                    Couldn’t check for updates: {info.error}
                  </div>
                ) : (
                  <div style={{ color: "var(--text-muted)" }}>You’re on the latest version.</div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
