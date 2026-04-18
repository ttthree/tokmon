import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface IconDropdownOption<T extends string> {
  value: T;
  label: string;
  /** Optional secondary line under the label. */
  description?: string;
  /** Optional leading visual (e.g. color swatches, badge). */
  leading?: ReactNode;
}

interface IconDropdownProps<T extends string> {
  /** Tooltip + aria label. */
  ariaLabel: string;
  /** Icon shown inside the trigger button. */
  icon: ReactNode;
  /** Header label inside the menu. */
  menuTitle: string;
  value: T;
  options: IconDropdownOption<T>[];
  onChange: (value: T) => void;
  /** Optional className addition for the trigger button. */
  className?: string;
  /** Width of the popover menu. */
  menuWidth?: number;
  /**
   * When true, the trigger shows the selected option's label inline next
   * to the icon. When false, only the icon (square h-8 w-8) is shown.
   */
  showLabel?: boolean;
  /** Max width (px) for the inline label, beyond which it truncates. */
  labelMaxWidth?: number;
}

const DEFAULT_MENU_WIDTH = 240;
const MENU_GAP = 4;

/**
 * Compact icon-button trigger that opens a portal-rendered menu.
 * Visually consistent with ThemePicker so all header controls share the
 * same h-8 square footprint.
 */
export function IconDropdown<T extends string>({
  ariaLabel,
  icon,
  menuTitle,
  value,
  options,
  onChange,
  className,
  menuWidth = DEFAULT_MENU_WIDTH,
  showLabel = true,
  labelMaxWidth = 140,
}: IconDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePos = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
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
  }, [open, menuWidth]);

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

  const selected = options.find((opt) => opt.value === value) ?? options[0];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${ariaLabel}: ${selected?.label ?? ""}`}
        onClick={() => setOpen((v) => !v)}
        className={
          "inline-flex h-8 items-center gap-1.5 rounded-md border outline-none transition-colors " +
          (showLabel ? "px-2" : "w-8 justify-center ") +
          (className ?? "")
        }
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--text-primary)",
        }}
      >
        <span className="flex shrink-0 items-center" style={{ color: "var(--text-secondary)" }}>
          {icon}
        </span>
        {showLabel ? (
          <>
            <span
              className="truncate text-xs font-medium leading-none"
              style={{ maxWidth: labelMaxWidth }}
            >
              {selected?.label ?? ""}
            </span>
            <ChevronDown />
          </>
        ) : null}
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
                width: menuWidth,
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
                {menuTitle}
              </div>
              <ul className="max-h-[60vh] overflow-y-auto py-1">
                {options.map((opt) => {
                  const isSelected = opt.value === value;
                  return (
                    <li key={opt.value}>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => {
                          onChange(opt.value);
                          setOpen(false);
                        }}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors"
                        style={{
                          background: isSelected ? "var(--bg-panel-muted)" : "transparent",
                          color: "var(--text-primary)",
                          fontFamily: "var(--font-body)",
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) e.currentTarget.style.background = "var(--bg-panel-muted)";
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) e.currentTarget.style.background = "transparent";
                        }}
                      >
                        {opt.leading ? <span className="shrink-0">{opt.leading}</span> : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{opt.label}</span>
                          {opt.description ? (
                            <span
                              className="block truncate text-xs"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {opt.description}
                            </span>
                          ) : null}
                        </span>
                        {isSelected ? <CheckIcon style={{ color: "var(--accent)" }} /> : null}
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

function ChevronDown() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: "var(--text-muted)" }}
    >
      <polyline points="6 9 12 15 18 9" />
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
