import { useSyncExternalStore } from "react";
import type { AnyExtension } from "@tiptap/core";
import type { SlashCommandDef, ToolbarItemDef, SettingsPanelDef, EmbedTypeDef } from "./defs.js";
import { KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES } from "@/shared/blockIds";

// ---------------------------------------------------------------------------
// Client plugin registry — a single module-level store that plugins fill via
// register*() calls during initPlugin(). React hooks (useSlashCommands etc.)
// re-render consumers when the registry changes.
// ---------------------------------------------------------------------------

// Slice-46 — input validation. Every register*() guards against three
// classes of bad plugin input:
//   1. EmbedType.name / SlashCommand.name colliding with a core block/inline
//      type — a plugin whose renderer matches "image" / "table" / "taskItem"
//      would hijack rendering of every page containing that type.
//   2. Duplicate registration — the embed map silently overwrites via Map.set
//      semantics, so a later-loaded plugin can clobber an earlier one without
//      either side noticing. We throw instead so the author finds the bug.
//   3. Malformed names / unbounded labels — a plugin shouldn't be able to
//      register labels that balloon the renderer or names that break
//      /^[a-z]/ lookups in tests and downstream code.
const SLASH_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const IDENT_RE = /^[a-zA-Z][a-zA-Z0-9-_]{0,63}$/;
const LABEL_MAX = 80;
const KEYWORD_MAX = 32;
const KEYWORD_COUNT_MAX = 16;

/** Common union of names that would clash with the host-rendered types. */
const RESERVED_NAMES = new Set<string>([...KNOWN_BLOCK_TYPES, ...KNOWN_INLINE_TYPES]);

function assertShape(
  label: string,
  name: string,
  regex: RegExp,
): void {
  if (typeof name !== "string" || !regex.test(name)) {
    throw new Error(
      `Plugin registry: ${label} name "${name}" is not a valid identifier (expected ${regex})`,
    );
  }
}

function assertLabel(label: string | undefined, kind: string): void {
  if (label === undefined) return;
  if (typeof label !== "string" || label.length === 0 || label.length > LABEL_MAX) {
    throw new Error(`Plugin registry: ${kind} label must be a string of 1..${LABEL_MAX} characters`);
  }
}

function assertKeywords(keywords: string[] | undefined, kind: string): void {
  if (keywords === undefined) return;
  if (!Array.isArray(keywords) || keywords.length > KEYWORD_COUNT_MAX) {
    throw new Error(`Plugin registry: ${kind} keywords must be an array of at most ${KEYWORD_COUNT_MAX} entries`);
  }
  for (const k of keywords) {
    if (typeof k !== "string" || k.length === 0 || k.length > KEYWORD_MAX) {
      throw new Error(`Plugin registry: ${kind} keyword must be a string of 1..${KEYWORD_MAX} characters`);
    }
  }
}

let tiptapExtensions: AnyExtension[] = [];
let slashCommands: SlashCommandDef[] = [];
let toolbarItems: ToolbarItemDef[] = [];
let settingsPanels: SettingsPanelDef[] = [];
let embedTypes: EmbedTypeDef[] = [];

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
  // Tiptap extensions are opaque — the schema (name, schema, commands) lives
  // inside the AnyExtension object. A plugin's name collision with a core
  // type is a Tiptap-schema concern, not a registry concern; Tiptap itself
  // rejects it during editor construction with a clear error.
  tiptapExtensions = [...tiptapExtensions, ext];
  notify();
}
export function registerSlashCommand(def: SlashCommandDef) {
  assertShape("slash command", def.name, SLASH_NAME_RE);
  if (RESERVED_NAMES.has(def.name)) {
    throw new Error(`Plugin registry: slash command name "${def.name}" collides with core block/inline type`);
  }
  assertLabel(def.label, "slash command");
  assertKeywords(def.keywords, "slash command");
  if (slashCommands.some((c) => c.name === def.name)) {
    throw new Error(`Plugin registry: slash command "${def.name}" is already registered`);
  }
  slashCommands = [...slashCommands, def];
  notify();
}
export function registerToolbarItem(def: ToolbarItemDef) {
  assertShape("toolbar item", def.id, IDENT_RE);
  assertLabel(def.label, "toolbar item");
  if (toolbarItems.some((t) => t.id === def.id)) {
    throw new Error(`Plugin registry: toolbar item "${def.id}" is already registered`);
  }
  toolbarItems = [...toolbarItems, def];
  notify();
}
export function registerSettingsPanel(def: SettingsPanelDef) {
  assertShape("settings panel", def.id, IDENT_RE);
  assertLabel(def.label, "settings panel");
  if (settingsPanels.some((p) => p.id === def.id)) {
    throw new Error(`Plugin registry: settings panel "${def.id}" is already registered`);
  }
  settingsPanels = [...settingsPanels, def];
  notify();
}
let _embedTypeMap: Map<string, EmbedTypeDef> | null = null;

/** Cached map — a fresh Map per call would break useSyncExternalStore (getSnapshot must return a stable reference when nothing changed). */
export function getEmbedTypeMap(): Map<string, EmbedTypeDef> {
  if (!_embedTypeMap) {
    _embedTypeMap = new Map();
    for (const et of embedTypes) _embedTypeMap.set(et.name, et);
  }
  return _embedTypeMap;
}

export function registerEmbedType(def: EmbedTypeDef) {
  assertShape("embed type", def.name, IDENT_RE);
  // Slice-46: even with the IDENT shape, reserving core block/inline names
  // is critical — the embedTypeMap is keyed by name and looked up by
  // node.type during rendering. A plugin registering { name: "image" }
  // would hijack every image in the wiki.
  if (RESERVED_NAMES.has(def.name)) {
    throw new Error(`Plugin registry: embed type "${def.name}" collides with core block/inline type`);
  }
  assertLabel(def.label, "embed type");
  if (embedTypes.some((e) => e.name === def.name)) {
    throw new Error(`Plugin registry: embed type "${def.name}" is already registered`);
  }
  embedTypes = [...embedTypes, def];
  _embedTypeMap = null;
  notify();
}

/**
 * Test-only — wipes every registry array so a Vitest describe block can
 * start from a clean slate. The real loader never calls this; the guard in
 * `loadPlugins` ensures registerCoreCommands() runs exactly once per page
 * load in production. Production callers must NOT call this.
 */
function _resetForTests(): void {
  tiptapExtensions.length = 0;
  slashCommands.length = 0;
  toolbarItems.length = 0;
  settingsPanels.length = 0;
  embedTypes.length = 0;
  _embedTypeMap = null;
  _pluginsLoaded = false;
}
/** Public alias of `_resetForTests` (so tests don't reach into a private function). */
export const resetRegistryForTests = _resetForTests;

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
  return useSyncExternalStore(subscribe, getEmbedTypeMap, getEmbedTypeMap);
}
