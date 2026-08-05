import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { api } from "../../api/client.js";

/** UI overhaul B4: "system" follows the OS preference live; the other three are explicit. */
export type Theme = "light" | "dark" | "contrast" | "system";

export type ResolvedTheme = Exclude<Theme, "system">;

/** A theme preset is a named collection of CSS variable overrides that replace
 *  the default surface/text/border/primary colors. The preset is applied in
 *  addition to the light/dark/contrast mode — if a preset sets a variable that
 *  the mode also sets, the preset wins (higher specificity via data-theme-preset).
 *
 *  `vars` maps CSS custom property names (without the `--` prefix) to values. */
export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  /** Color of the preview card badge (used in Settings UI). */
  previewColor: string;
  /** Whether this preset is designed for light or dark mode (used as a hint). */
  kind: "light" | "dark";
  vars: Record<string, string>;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "default-blue",
    name: "Default Blue",
    description: "The original wiki theme — clean blue accents across light and dark modes.",
    previewColor: "#1f6feb",
    kind: "light",
    vars: {},
  },
  {
    id: "github-light",
    name: "GitHub Light",
    description: "Airy, high-contrast light theme inspired by GitHub's Primer design system.",
    previewColor: "#0969da",
    kind: "light",
    vars: {
      "color-bg": "#ffffff",
      "color-bg-secondary": "#f6f8fa",
      "color-bg-tertiary": "#eaeef2",
      "color-surface": "#ffffff",
      "color-surface-hover": "#f3f4f6",
      "color-surface-elevated": "#ffffff",
      "color-text": "#1f2328",
      "color-text-secondary": "#656d76",
      "color-text-muted": "#8b949e",
      "color-border": "#d0d7de",
      "color-border-light": "#e8eaed",
      "color-primary": "#0969da",
      "color-primary-hover": "#0550ae",
      "color-link": "#0969da",
      "color-focus-ring": "rgba(9, 105, 218, 0.35)",
      "color-code-bg": "#f6f8fa",
      "color-code-text": "#1f2328",
      "color-inline-code-bg": "#eaeef2",
      "color-inline-code-text": "#1f2328",
      "color-blockquote-bg": "#f6f8fa",
      "color-blockquote-border": "#d0d7de",
      "table-header-bg": "#f6f8fa",
      "radius-sm": "0.25rem",
      "radius-md": "0.375rem",
      "radius-lg": "0.5rem",
      "font-sans": "'-apple-system', BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "font-mono": "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "Ethan Schoonover's classic warm-dark palette — easy on the eyes for long writing sessions.",
    previewColor: "#268bd2",
    kind: "dark",
    vars: {
      "color-bg": "#002b36",
      "color-bg-secondary": "#073642",
      "color-bg-tertiary": "#094352",
      "color-surface": "#073642",
      "color-surface-hover": "#0a4a5c",
      "color-surface-elevated": "#073642",
      "color-text": "#839496",
      "color-text-secondary": "#657b83",
      "color-text-muted": "#586e75",
      "color-border": "#094352",
      "color-border-light": "#05232b",
      "color-border-strong": "#586e75",
      "color-primary": "#268bd2",
      "color-primary-hover": "#1e7ab9",
      "color-primary-text": "#002b36",
      "color-link": "#268bd2",
      "color-focus-ring": "rgba(38, 139, 210, 0.35)",
      "color-code-bg": "#073642",
      "color-code-text": "#839496",
      "color-inline-code-bg": "#094352",
      "color-inline-code-text": "#b58900",
      "color-blockquote-bg": "#073642",
      "color-blockquote-border": "#586e75",
      "color-table-header-bg": "#073642",
      "color-danger": "#dc322f",
      "color-danger-hover": "#c02826",
      "color-highlight-bg": "#586e75",
      "color-highlight-text": "#fdf6e3",
      "shadow-sm": "0 1px 2px rgba(0,0,0,0.25)",
      "shadow-md": "0 4px 6px rgba(0,0,0,0.3)",
      "shadow-lg": "0 10px 25px rgba(0,0,0,0.4)",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "Vibrant dark theme with purple backgrounds and bright green/pink accents.",
    previewColor: "#bd93f9",
    kind: "dark",
    vars: {
      "color-bg": "#282a36",
      "color-bg-secondary": "#343746",
      "color-bg-tertiary": "#3e4056",
      "color-surface": "#343746",
      "color-surface-hover": "#44475a",
      "color-surface-elevated": "#343746",
      "color-text": "#f8f8f2",
      "color-text-secondary": "#bfbfbf",
      "color-text-muted": "#6272a4",
      "color-border": "#44475a",
      "color-border-light": "#343746",
      "color-border-strong": "#6272a4",
      "color-primary": "#bd93f9",
      "color-primary-hover": "#a87cf0",
      "color-primary-text": "#282a36",
      "color-link": "#8be9fd",
      "color-focus-ring": "rgba(189, 147, 249, 0.35)",
      "color-code-bg": "#343746",
      "color-code-text": "#f8f8f2",
      "color-inline-code-bg": "#44475a",
      "color-inline-code-text": "#ffb86c",
      "color-blockquote-bg": "#343746",
      "color-blockquote-border": "#6272a4",
      "color-table-header-bg": "#343746",
      "color-danger": "#ff5555",
      "color-danger-hover": "#e04444",
      "color-success": "#50fa7b",
      "color-warning": "#ffb86c",
      "color-highlight-bg": "#44475a",
      "color-highlight-text": "#f8f8f2",
      "shadow-sm": "0 1px 2px rgba(0,0,0,0.3)",
      "shadow-md": "0 4px 6px rgba(0,0,0,0.4)",
      "shadow-lg": "0 10px 25px rgba(0,0,0,0.5)",
    },
  },
  {
    id: "nord",
    name: "Nord",
    description: "Cool blue-grey palette inspired by Arctic landscapes — subdued and professional.",
    previewColor: "#5e81ac",
    kind: "dark",
    vars: {
      "color-bg": "#2e3440",
      "color-bg-secondary": "#3b4252",
      "color-bg-tertiary": "#434c5e",
      "color-surface": "#3b4252",
      "color-surface-hover": "#4c566a",
      "color-surface-elevated": "#3b4252",
      "color-text": "#eceff4",
      "color-text-secondary": "#c8cdd6",
      "color-text-muted": "#7b88a1",
      "color-border": "#4c566a",
      "color-border-light": "#3b4252",
      "color-border-strong": "#5e81ac",
      "color-primary": "#5e81ac",
      "color-primary-hover": "#81a1c1",
      "color-primary-text": "#eceff4",
      "color-link": "#88c0d0",
      "color-focus-ring": "rgba(94, 129, 172, 0.35)",
      "color-code-bg": "#3b4252",
      "color-code-text": "#eceff4",
      "color-inline-code-bg": "#434c5e",
      "color-inline-code-text": "#d08770",
      "color-blockquote-bg": "#3b4252",
      "color-blockquote-border": "#5e81ac",
      "color-table-header-bg": "#3b4252",
      "color-danger": "#bf616a",
      "color-danger-hover": "#a5535b",
      "color-success": "#a3be8c",
      "color-warning": "#ebcb8b",
      "color-highlight-bg": "#4c566a",
      "color-highlight-text": "#eceff4",
      "shadow-sm": "0 1px 2px rgba(0,0,0,0.2)",
      "shadow-md": "0 4px 6px rgba(0,0,0,0.3)",
      "shadow-lg": "0 10px 25px rgba(0,0,0,0.4)",
    },
  },
];

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleLightDark: () => void;
  /** Actual theme applied to <html data-theme> (system resolves to light/dark). */
  resolvedTheme: ResolvedTheme;
  /** Accent color hex currently applied, or null for the theme default. */
  accent: string | null;
  setAccent: (hex: string | null) => void;
  /** Active theme preset ID, or null if using the defaults. */
  presetId: string | null;
  setPresetId: (id: string | null) => void;
}

const ThemeContext = createContext<ThemeCtx>({
  theme: "light",
  setTheme: () => {},
  toggleLightDark: () => {},
  resolvedTheme: "light",
  accent: null,
  setAccent: () => {},
  presetId: null,
  setPresetId: () => {},
});

const STORAGE_KEY = "wiki-theme";
const ACCENT_SETTING_KEY = "theme.accent";
const PRESET_SETTING_KEY = "theme.preset";

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
  const [presetId, setPresetIdState] = useState<string | null>(null);
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

  // Load user settings once on mount.
  useEffect(() => {
    api.getUserSettings().then((s) => {
      const storedAccent = s[ACCENT_SETTING_KEY];
      if (typeof storedAccent === "string" && ACCENTS[storedAccent]) setAccentState(storedAccent);
      const storedPreset = s[PRESET_SETTING_KEY];
      if (typeof storedPreset === "string" && THEME_PRESETS.some((p) => p.id === storedPreset)) {
        setPresetIdState(storedPreset);
      }
    }).catch(() => {});
  }, []);

  const setAccent = useCallback((hex: string | null) => {
    setAccentState(hex);
    if (hex) api.setUserSetting(ACCENT_SETTING_KEY, hex).catch(() => {});
    else api.setUserSetting(ACCENT_SETTING_KEY, null).catch(() => {});
  }, []);

  const setPresetId = useCallback((id: string | null) => {
    setPresetIdState(id);
    if (id) api.setUserSetting(PRESET_SETTING_KEY, id).catch(() => {});
    else api.setUserSetting(PRESET_SETTING_KEY, null).catch(() => {});
  }, []);

  // Apply data-theme, accent, and preset whenever they change.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    applyAccent(accent, resolvedTheme);
  }, [resolvedTheme, accent]);

  // Apply preset CSS variable overrides. These are set directly on :root so they
  // win over the default theme tokens but accent overrides (applied last) win over
  // preset overrides.
  useEffect(() => {
    const el = document.documentElement;
    // Clear all previous preset overrides.
    for (const preset of THEME_PRESETS) {
      for (const key of Object.keys(preset.vars)) {
        el.style.removeProperty(`--${key}`);
      }
    }
    if (presetId) {
      const preset = THEME_PRESETS.find((p) => p.id === presetId);
      if (preset) {
        for (const [key, value] of Object.entries(preset.vars)) {
          el.style.setProperty(`--${key}`, value);
        }
      }
    }
  }, [presetId]);

  const value = useMemo<ThemeCtx>(
    () => ({ theme, setTheme, toggleLightDark, resolvedTheme, accent, setAccent, presetId, setPresetId }),
    [theme, setTheme, toggleLightDark, resolvedTheme, accent, setAccent, presetId, setPresetId]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
