import { useCallback, useEffect, useState } from "react";

// Slice-14 Appearance (§7.1). The token set already ships dark + contrast
// overrides keyed on `[data-theme]` (styles/tokens.css) — this hook is the
// switch. Persisted per-browser (localStorage); index.html applies it before
// first paint so there is no flash of the wrong theme.
export type Theme = "light" | "dark" | "contrast";
export const THEMES: readonly Theme[] = ["light", "dark", "contrast"] as const;
export const THEME_LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  contrast: "High contrast",
};
const THEME_KEY = "wiki.theme";

function systemTheme(): Exclude<Theme, "contrast"> {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getStoredTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark" || t === "contrast") return t;
  } catch {
    /* storage unavailable (private mode / SSR) — fall through to default */
  }
  return null;
}

export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  if (theme === "light") delete el.dataset.theme;
  else el.dataset.theme = theme;
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme() ?? systemTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage unavailable */
    }
    setThemeState(t);
  }, []);

  return { theme, setTheme };
}
