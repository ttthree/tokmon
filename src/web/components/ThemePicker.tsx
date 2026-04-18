import { THEME_LIST, type ThemeId } from "../theme/themes.js";
import { useTheme } from "../theme/ThemeProvider.js";
import { IconDropdown, type IconDropdownOption } from "./IconDropdown.js";

export function ThemePicker() {
  const { themeId, setThemeId } = useTheme();

  const options: IconDropdownOption<ThemeId>[] = THEME_LIST.map((t) => ({
    value: t.id,
    label: t.label,
    description: t.description,
    leading: (
      <span className="flex items-center gap-0.5">
        {t.colors.chartPalette.slice(0, 5).map((c, i) => (
          <span
            key={i}
            className="inline-block h-3.5 w-3.5 rounded-sm"
            style={{ background: c, border: "1px solid var(--border)" }}
          />
        ))}
      </span>
    ),
  }));

  return (
    <IconDropdown
      ariaLabel="Theme"
      menuTitle="Theme"
      icon={<PaletteIcon />}
      value={themeId}
      options={options}
      onChange={setThemeId}
      showLabel={false}
      menuWidth={256}
    />
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
