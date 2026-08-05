import { useEffect } from "react";
import { getPlugins, usePluginState, usePluginToggle, loadPluginState } from "../plugins/pluginRegistry.js";
import { cn } from "../../lib/utils.js";
import { Puzzle } from "lucide-react";

export function PluginSection() {
  useEffect(() => { loadPluginState(); }, []);

  const state = usePluginState();
  const toggle = usePluginToggle();
  const plugins = getPlugins();

  const byCategory: Record<string, typeof plugins> = {};
  for (const p of plugins) {
    (byCategory[p.category] ??= []).push(p);
  }

  return (
    <section className="settings-card">
      <h3>Plugins</h3>
      <p className="hint" style={{ marginBottom: 12 }}>
        Enable or disable built-in plugins. Disabled plugins stop executing on the client immediately.
      </p>
      {Object.entries(byCategory).map(([cat, items]) => (
        <div key={cat} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: "var(--font-size-xs)", fontWeight: 600, textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 6 }}>
            {cat}
          </div>
          {items.map((p) => (
            <label
              key={p.id}
              className={cn("settings-plugin-row", !p.builtIn && "settings-plugin-row-custom")}
            >
              <div className="settings-plugin-info">
                <span className="settings-plugin-name">
                  <Puzzle className="h-3.5 w-3.5" style={{ opacity: 0.5 }} />
                  {p.name}
                </span>
                <span className="settings-plugin-desc">{p.description}</span>
              </div>
              <input
                type="checkbox"
                checked={state[p.id] ?? true}
                onChange={(e) => toggle(p.id, e.target.checked)}
                className="settings-plugin-toggle"
              />
            </label>
          ))}
        </div>
      ))}
    </section>
  );
}
