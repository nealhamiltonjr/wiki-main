import { createFileRoute } from "@tanstack/react-router";
import { THEMES, THEME_LABELS, useTheme } from "@/features/settings/useTheme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings/appearance")({
  component: AppearanceSettingsPage,
});

function AppearanceSettingsPage() {
  const { theme, setTheme } = useTheme();

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
    </div>
  );
}
