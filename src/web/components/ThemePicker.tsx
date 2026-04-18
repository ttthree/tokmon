import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { THEME_LIST } from "../theme/themes.js";
import { useTheme } from "../theme/ThemeProvider.js";

const MENU_WIDTH = 256;
const MENU_GAP = 4;

export function ThemePicker() {
  const { themeId, setThemeId } = useTheme();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position the menu under the button, right-aligned, clamped to viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePos = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(window.innerWidth - MENU_WIDTH - 8, rect.right - MENU_WIDTH),
      );
      const top = rect.bottom + MENU_GAP;
      setPos({ top, left });
    };
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
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

  const current = THEME_LIST.find((t) => t.id === themeId) ?? THEME_LIST[0];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Theme: ${current.label}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border outline-none transition-colors"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--text-primary)",
        }}
      >
        <PaletteIcon />
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="fixed overflow-hidden rounded-md border shadow-lg"
              style={{
                top: pos.top,
                left: pos.left,
                width: MENU_WIDTH,
                zIndex: 9999,
                background: "var(--bg-panel)",
                borderColor: "var(--border)",
                boxShadow: "var(--shadow-card, 0 8px 24px rgba(0,0,0,0.18))",
              }}
            >
              <div
                className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  color: "var(--text-muted)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                Theme
              </div>
              <ul className="max-h-[60vh] overflow-y-auto py-1">
                {THEME_LIST.map((t) => {
                  const selected = t.id === themeId;
                  const swatches = t.colors.chartPalette.slice(0, 5);
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => {
                          setThemeId(t.id);
                          setOpen(false);
                        }}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors"
                        style={{
                          background: selected ? "var(--bg-panel-muted)" : "transparent",
                          color: "var(--text-primary)",
                          fontFamily: "var(--font-body)",
                        }}
                        onMouseEnter={(e) => {
                          if (!selected) e.currentTarget.style.background = "var(--bg-panel-muted)";
                        }}
                        onMouseLeave={(e) => {
                          if (!selected) e.currentTarget.style.background = "transparent";
                        }}
                      >
                        <span className="flex shrink-0 items-center gap-0.5">
                          {swatches.map((c, i) => (
                            <span
                              key={i}
                              className="inline-block h-3.5 w-3.5 rounded-sm"
                              style={{
                                background: c,
                                border: "1px solid var(--border)",
                              }}
                            />
                          ))}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{t.label}</span>
                          <span
                            className="block truncate text-xs"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {t.description}
                          </span>
                        </span>
                        {selected ? <CheckIcon style={{ color: "var(--accent)" }} /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function PaletteIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9z" />
    </svg>
  );
}

function CheckIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
