import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { DEFAULT_THEME_ID, THEMES, type Theme, type ThemeId } from "./themes.js";

const STORAGE_KEY = "tokmon:theme";

interface ThemeContextValue {
  theme: Theme;
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitial(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && stored in THEMES) return stored as ThemeId;
  } catch {
    // ignore
  }
  return DEFAULT_THEME_ID;
}

function applyThemeVars(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  for (const [key, value] of Object.entries(theme.cssVars)) {
    root.style.setProperty(key, value);
  }
  document.body.style.background = theme.cssVars["--bg-app"] ?? "";
  document.body.style.color = theme.cssVars["--text-primary"] ?? "";
  document.body.style.fontFamily = theme.cssVars["--font-body"] ?? "";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>(readInitial);

  useEffect(() => {
    applyThemeVars(THEMES[themeId]);
    try {
      window.localStorage.setItem(STORAGE_KEY, themeId);
    } catch {
      // ignore
    }
  }, [themeId]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: THEMES[themeId], themeId, setThemeId: setThemeIdState }),
    [themeId],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
