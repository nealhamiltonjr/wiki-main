import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { api } from "../../api/client.js";

/** UI overhaul B4: "system" follows the OS preference live; the other three are explicit. */
export type Theme = "light" | "dark" | "contrast" | "system";

export type ResolvedTheme = Exclude<Theme, "system">;

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleLightDark: () => void;
  /** Actual theme applied to <html data-theme> (system resolves to light/dark). */
  resolvedTheme: ResolvedTheme;
  /** Accent color hex currently applied, or null for the theme default. */
  accent: string | null;
  setAccent: (hex: string | null) => void;
}

const ThemeContext = createContext<ThemeCtx>({
  theme: "light",
  setTheme: () => {},
  toggleLightDark: () => {},
  resolvedTheme: "light",
  accent: null,
  setAccent: () => {},
});

const STORAGE_KEY = "wiki-theme";
const ACCENT_SETTING_KEY = "theme.accent";

// Accent palettes (UI overhaul B4). Only the primary-ish variables change; the
// rest of the theme (surfaces/text/borders) is untouched so contrast stays sane.
const ACCENTS: Record<string, { primary: string; hover: string; link: string; ring: string }> = {
  "#1f6feb": { primary: "#1f6feb", hover: "#1158c7", link: "#0969da", ring: "rgba(31, 111, 235, 0.35)" },
  "#9c36b5": { primary: "#9c36b5", hover: "#8430a0", link: "#8e1fc0", ring: "rgba(156, 54, 181, 0.4)" },
  "#0f766e": { primary: "#0f766e", hover: "#115e59", link: "#0d9488", ring: "rgba(15, 118, 110, 0.4)" },
  "#b45309": { primary: "#b45309", hover: "#92400e", link: "#b45309", ring: "rgba(180, 83, 9, 0.4)" },
  "#be123c": { primary: "#be123c", hover: "#9f1239", link: "#be123c", ring: "rgba(190, 18, 60, 0.4)" },
  "#4d7c0f": { primary: "#4d7c0f", hover: "#3f6212", link: "#4d7c0f", ring: "rgba(77, 124, 15, 0.4)" },
};
const ACCENT_NAMES: Record<string, string> = {
  "#1f6feb": "Default blue",
  "#9c36b5": "Purple",
  "#0f766e": "Teal",
  "#b45309": "Amber",
  "#be123c": "Rose",
  "#4d7c0f": "Olive",
};

export const ACCENT_OPTIONS = Object.entries(ACCENTS).map(([hex, v]) => ({ hex, ...v, name: ACCENT_NAMES[hex] ?? hex }));

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "contrast" || stored === "system") return stored;
  } catch { /* localStorage unavailable */ }
  return "system";
}

function applyAccent(accent: string | null, resolved: ResolvedTheme) {
  const el = document.documentElement;
  const set = (name: string, value: string | null) => {
    if (value === null) el.style.removeProperty(name);
    else el.style.setProperty(name, value);
  };
  if (accent && ACCENTS[accent]) {
    const a = ACCENTS[accent]!;
    set("--color-primary", a.primary);
    set("--color-primary-hover", a.hover);
    set("--color-link", a.link);
    set("--color-focus-ring", a.ring);
  } else {
    set("--color-primary", null);
    set("--color-primary-hover", null);
    set("--color-link", null);
    set("--color-focus-ring", null);
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [accent, setAccentState] = useState<string | null>(null);
  // Re-resolve on every render so the effect below can react to OS changes.
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  const resolvedTheme: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(STORAGE_KEY, t); } catch {}
  }, []);

  const toggleLightDark = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  // Load the user's accent from user_settings once on mount.
  useEffect(() => {
    api.getUserSettings().then((s) => {
      const stored = s[ACCENT_SETTING_KEY];
      if (typeof stored === "string" && ACCENTS[stored]) setAccentState(stored);
    }).catch(() => {});
  }, []);

  const setAccent = useCallback((hex: string | null) => {
    setAccentState(hex);
    if (hex) api.setUserSetting(ACCENT_SETTING_KEY, hex).catch(() => {});
    else api.setUserSetting(ACCENT_SETTING_KEY, null).catch(() => {});
  }, []);

  // Apply data-theme + accent whenever the resolved theme/accent changes.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    applyAccent(accent, resolvedTheme);
  }, [resolvedTheme, accent]);

  const value = useMemo<ThemeCtx>(
    () => ({ theme, setTheme, toggleLightDark, resolvedTheme, accent, setAccent }),
    [theme, setTheme, toggleLightDark, resolvedTheme, accent, setAccent]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
