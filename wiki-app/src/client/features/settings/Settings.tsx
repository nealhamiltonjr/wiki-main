import { useEffect, useState } from "react";
import { useTheme, type Theme } from "../theme/ThemeContext.js";
import { AdminSettings } from "./AdminSettings.js";
import { useSession } from "../../api/authClient.js";
import { api } from "../../api/client.js";

/**
 * Settings page. Two parts:
 * - "Appearance" is available to every user (theme + editor reading width,
 *   persisted via user_settings).
 * - The admin-only management sections (groups, system settings) are only
 *   rendered when the signed-in user is a global admin.
 */
export function Settings() {
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
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

  const isAdmin = session?.user.isAdmin === true;

  return (
    <div className="settings-page">
      <h2>Settings</h2>

      <section className="settings-card">
        <h3>Appearance</h3>
        <div className="settings-row">
          <span className="label">Theme</span>
          {(["light", "dark", "contrast"] as Theme[]).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className={`settings-pill${theme === t ? " active" : ""}`}
            >
              {t}
            </button>
          ))}
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

      {isAdmin && <AdminSettings />}
    </div>
  );
}
