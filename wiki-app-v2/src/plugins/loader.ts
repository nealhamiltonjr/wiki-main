import type { PluginInfo } from "@/shared/pluginTypes";
import { createPluginAPI } from "./api.js";
import { markPluginsLoaded } from "./registry.js";
import { registerCoreCommands } from "./coreCommands.js";
import { request } from "@/api/client";

let _loaded = false;

/**
 * Loads all enabled plugin client bundles. Must be called before the app's
 * first editor mounts so the registry is populated. Idempotent — subsequent
 * calls are no-ops. A failing plugin is caught and logged; it never prevents
 * the rest of the app from booting.
 *
 * Core commands (§13.6 — first-class content types like Mermaid) are
 * registered before the user-plugin loop so they're always present, even if
 * every user plugin fails to fetch.
 */
export async function loadPlugins(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  registerCoreCommands();

  let plugins: PluginInfo[];
  try {
    plugins = await request<PluginInfo[]>("/api/plugins");
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[plugins] Failed to load plugin list — continuing without plugins");
    markPluginsLoaded();
    return;
  }

  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const hasClient = plugin.capabilities.tiptapExtensions
      || plugin.capabilities.slashCommands
      || plugin.capabilities.toolbarItems
      || plugin.capabilities.settingsPanel
      || plugin.capabilities.embedTypes;
    if (!hasClient) continue;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mod: { default?: (api: ReturnType<typeof createPluginAPI>) => void } = await import(
        /* @vite-ignore */`/plugins/${plugin.id}/client/index.js`
      );
      if (typeof mod.default !== "function") {
        // eslint-disable-next-line no-console
        console.warn(`[plugins] "${plugin.id}" client/index.js must default-export a register(api) function`);
        continue;
      }
      const api = createPluginAPI(plugin.capabilities);
      mod.default(api);
      // eslint-disable-next-line no-console
      console.log(`[plugins] Loaded "${plugin.id}"`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[plugins] Failed to load "${plugin.id}":`, err);
    }
  }
  markPluginsLoaded();
}

/** Exported for tests — reset the loaded guard so loadPlugins can be called again. */
export function _resetLoadState() {
  _loaded = false;
}
