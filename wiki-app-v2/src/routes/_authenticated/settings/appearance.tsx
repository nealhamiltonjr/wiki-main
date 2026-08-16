import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { THEMES, THEME_LABELS, useTheme } from "@/features/settings/useTheme";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings/appearance")({
  component: AppearanceSettingsPage,
});

const EDITOR_WIDTHS = [
  { value: "60ch", label: "Narrow" },
  { value: "72ch", label: "Default" },
  { value: "90ch", label: "Wide" },
  { value: "100%", label: "Full" },
];

function AppearanceSettingsPage() {
  const { theme, setTheme } = useTheme();
  const [editorWidth, setEditorWidth] = useState("72ch");

  useEffect(() => {
    let mounted = true;
    void api.getUserSettings().then((rows) => {
      const row = rows.find((r) => r.key === "editor.width");
      if (mounted && typeof row?.value === "string") setEditorWidth(row.value);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--editor-width", editorWidth);
  }, [editorWidth]);

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-medium">Appearance</h2>
        <p className="text-sm text-text-muted">
          Theme is a token swap (styles/tokens.css) — components never branch on theme.
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Theme</h3>
        <div className="flex gap-2">
          {THEMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              aria-pressed={theme === t}
              className={cn(
                "rounded-md border px-4 py-2 text-sm transition-colors",
                theme === t
                  ? "border-border-strong bg-surface-elevated font-medium text-foreground"
                  : "border-border bg-background text-text-secondary hover:bg-surface-hover"
              )}
            >
              {THEME_LABELS[t]}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted" data-theme-state>
          Current: {THEME_LABELS[theme]} ({theme})
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Editor width</h3>
        <div className="flex gap-2">
          {EDITOR_WIDTHS.map((w) => (
            <button
              key={w.value}
              type="button"
              onClick={() => {
                const prev = editorWidth;
                setEditorWidth(w.value);
                void api.setUserSetting("editor.width", w.value).catch(() => {
                  setEditorWidth(prev);
                });
              }}
              aria-pressed={editorWidth === w.value}
              className={cn(
                "rounded-md border px-4 py-2 text-sm transition-colors",
                editorWidth === w.value
                  ? "border-border-strong bg-surface-elevated font-medium text-foreground"
                  : "border-border bg-background text-text-secondary hover:bg-surface-hover"
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
