/**
 * Shared plugin types (§4). The manifest is a REAL contract: the server
 * validates it strictly (Zod `.strict()` — a field the schema doesn't know is
 * a reject, not an ignore) and the client PluginAPI only exposes the methods
 * whose capability the manifest declared `true`. A bundle that calls an
 * undeclared registration throws.
 */

export const PLUGIN_CAPABILITY_KEYS = [
  "tiptapExtensions",
  "slashCommands",
  "toolbarItems",
  "settingsPanel",
  "embedTypes",
  "serverRoutes",
  "hooks",
] as const;

export type PluginCapabilityKey = (typeof PLUGIN_CAPABILITY_KEYS)[number];

export interface PluginCapabilities {
  tiptapExtensions: boolean;
  slashCommands: boolean;
  toolbarItems: boolean;
  settingsPanel: boolean;
  embedTypes: boolean;
  serverRoutes: boolean;
  /** Brief §13.5: server-side event hooks (pageLoad/pageSave/attributeChange). */
  hooks: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  capabilities: PluginCapabilities;
  /**
   * Declared content-model node/mark type names. The server needs these so its
   * save/read validator (validateContent) keeps accepting plugin-provided node
   * types while the plugin is enabled; without an explicit declaration there is
   * no way for the server to know a plugin added node "drawioDiagram".
   */
  contentModel?: {
    nodes: string[];
    marks: string[];
  };
}

/** What the client needs to know about an installed plugin (GET /api/plugins). */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  capabilities: PluginCapabilities;
  nodeTypes: string[];
  markTypes: string[];
  installedAt: string;
}
