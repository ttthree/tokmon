import { THEME_LIST } from "../theme/themes.js";
import { useTheme } from "../theme/ThemeProvider.js";

export function ThemePicker() {
  const { themeId, setThemeId } = useTheme();
  return (
    <div className="inline-flex items-center gap-2">
      <label className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        Theme
      </label>
      <select
        aria-label="Theme"
        value={themeId}
        onChange={(e) => setThemeId(e.target.value as typeof themeId)}
        className="rounded-md border px-2 py-1 text-sm outline-none"
        style={{
          background: "var(--bg-panel)",
          color: "var(--text-primary)",
          borderColor: "var(--border)",
          fontFamily: "var(--font-body)",
        }}
      >
        {THEME_LIST.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}
