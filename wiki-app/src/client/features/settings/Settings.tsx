import { useEffect, useState } from "react";
import { useTheme, ACCENT_OPTIONS, THEME_PRESETS, type Theme } from "../theme/ThemeContext.js";
import { AdminSettings } from "./AdminSettings.js";
import { useSession } from "../../api/authClient.js";
import { api } from "../../api/client.js";
import { cn } from "../../lib/utils.js";
import { Check, Palette } from "lucide-react";

const THEMES: Theme[] = ["light", "dark", "contrast", "system"];

/**
 * Settings page. Two parts:
 * - "Appearance" is available to every user (theme + editor reading width,
 *   persisted via user_settings).
 * - The admin-only management sections (groups, system settings) are only
 *   rendered when the signed-in user is a global admin.
 */
export function Settings() {
  const { data: session } = useSession();
  const { theme, setTheme, accent, setAccent } = useTheme();
  const [editorWidth, setEditorWidth] = useState<"full" | "narrow">("full");

  useEffect(() => {
    api.getUserSettings().then((s) => {
      if (s["editor.width"] === "narrow" || s["editor.width"] === "full") {
        setEditorWidth(s["editor.width"]);
      }
    });
  }, []);

  function toggleWidth() {
    const next = editorWidth === "full" ? "narrow" : "full";
    setEditorWidth(next);
    api.setUserSetting("editor.width", next);
  }

  const { presetId, setPresetId } = useTheme();
  const isAdmin = session?.user.isAdmin === true;

  return (
    <div className="settings-page">
      <h2>Settings</h2>

      <section className="settings-card">
        <h3>Appearance</h3>
        <div className="settings-row">
          <span className="label">Theme</span>
          <div className="settings-theme-pills">
            {THEMES.map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`settings-pill${theme === t ? " active" : ""}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="label">Accent</span>
          <div className="settings-accent-row" role="radiogroup" aria-label="Accent color">
            {ACCENT_OPTIONS.map((opt) => {
              const active = accent === opt.hex;
              return (
                <button
                  key={opt.hex}
                  role="radio"
                  aria-checked={active}
                  title={opt.name}
                  onClick={() => setAccent(active ? null : opt.hex)}
                  className={cn("settings-accent-swatch", active && "active")}
                  style={{ backgroundColor: opt.primary, color: opt.primary === "#ffee00" ? "#000" : "#fff" }}
                >
                  {active && <Check className="h-3.5 w-3.5" aria-hidden />}
                </button>
              );
            })}
            <span className="hint" style={{ marginLeft: 8 }}>
              {accent ? ACCENT_OPTIONS.find((o) => o.hex === accent)?.name : "Theme default"}
            </span>
          </div>
        </div>
        <div className="settings-row">
          <span className="label">Editor width</span>
          <button onClick={toggleWidth} className="settings-btn">
            {editorWidth === "full" ? "Full width" : "Narrow"}
          </button>
          <span className="hint">
            {editorWidth === "full" ? "Editor spans the whole panel" : "Editor constrained to reading width"}
          </span>
        </div>
      </section>

      <section className="settings-card">
        <h3>Theme preset</h3>
        <p className="hint" style={{ marginBottom: 12 }}>
          Override the default color palette with a curated preset. Presets work across light and dark modes.
        </p>
        <div className="settings-preset-grid">
          {THEME_PRESETS.map((preset) => {
            const active = presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={cn("settings-preset-card", active && "active")}
                onClick={() => setPresetId(active ? null : preset.id)}
                title={preset.description}
              >
                <div className="settings-preset-preview" style={{ backgroundColor: preset.previewColor }}>
                  <Palette className="h-4 w-4" style={{ color: "#fff" }} />
                  <span className="settings-preset-kind">{preset.kind}</span>
                </div>
                <div className="settings-preset-body">
                  <span className="settings-preset-name">{preset.name}</span>
                  <span className="settings-preset-desc">{preset.description}</span>
                </div>
                {active && <Check className="settings-preset-check h-4 w-4" aria-hidden />}
              </button>
            );
          })}
        </div>
      </section>

      {isAdmin && <AdminSettings />}
    </div>
  );
}
