import { useSyncExternalStore } from "react";
import type { AnyExtension } from "@tiptap/core";
import type { SlashCommandDef, ToolbarItemDef, SettingsPanelDef, EmbedTypeDef } from "./defs.js";

// ---------------------------------------------------------------------------
// Client plugin registry — a single module-level store that plugins fill via
// register*() calls during initPlugin(). React hooks (useSlashCommands etc.)
// re-render consumers when the registry changes.
// ---------------------------------------------------------------------------

const tiptapExtensions: AnyExtension[] = [];
const slashCommands: SlashCommandDef[] = [];
const toolbarItems: ToolbarItemDef[] = [];
const settingsPanels: SettingsPanelDef[] = [];
const embedTypes: EmbedTypeDef[] = [];

let listeners = new Set<() => void>();
let _pluginsLoaded = false;

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function notify() {
  for (const l of listeners) l();
}

export function markPluginsLoaded() { _pluginsLoaded = true; notify(); }

export function usePluginsLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => _pluginsLoaded, () => false);
}

// Must reset listeners on hot-module reload.
if (typeof import.meta !== "undefined" && (import.meta as any).hot) {
  (import.meta as any).hot.dispose(() => {
    listeners = new Set();
  });
}

export function registerTiptapExtension(ext: AnyExtension) {
  tiptapExtensions.push(ext);
  notify();
}
export function registerSlashCommand(def: SlashCommandDef) {
  slashCommands.push(def);
  notify();
}
export function registerToolbarItem(def: ToolbarItemDef) {
  toolbarItems.push(def);
  notify();
}
export function registerSettingsPanel(def: SettingsPanelDef) {
  settingsPanels.push(def);
  notify();
}
export function registerEmbedType(def: EmbedTypeDef) {
  embedTypes.push(def);
  notify();
}

// Read-only accessors (used by the editor, toolbar, etc.)
export function getTiptapExtensions(): AnyExtension[] { return tiptapExtensions; }
export function getSlashCommands(): SlashCommandDef[] { return slashCommands; }
export function getToolbarItems(): ToolbarItemDef[] { return toolbarItems; }
export function getSettingsPanels(): SettingsPanelDef[] { return settingsPanels; }
export function getEmbedTypes(): EmbedTypeDef[] { return embedTypes; }

// React hooks that re-render when plugins are loaded.
export function useTiptapExtensions(): AnyExtension[] {
  return useSyncExternalStore(subscribe, getTiptapExtensions, getTiptapExtensions);
}
export function useSlashCommands(): SlashCommandDef[] {
  return useSyncExternalStore(subscribe, getSlashCommands, getSlashCommands);
}
export function useToolbarItems(): ToolbarItemDef[] {
  return useSyncExternalStore(subscribe, getToolbarItems, getToolbarItems);
}
export function useSettingsPanels(): SettingsPanelDef[] {
  return useSyncExternalStore(subscribe, getSettingsPanels, getSettingsPanels);
}
export function useEmbedTypes(): EmbedTypeDef[] {
  return useSyncExternalStore(subscribe, getEmbedTypes, getEmbedTypes);
}

/**
 * Returns a map from node type name → EmbedTypeDef so ReadOnlyContent can
 * find the correct renderer for a plugin node when editing is NOT enabled
 * (read-only view or disabled plugin).
 */
export function useEmbedTypeMap(): Map<string, EmbedTypeDef> {
  return useSyncExternalStore(subscribe, () => {
    const m = new Map<string, EmbedTypeDef>();
    for (const et of embedTypes) m.set(et.name, et);
    return m;
  });
}
