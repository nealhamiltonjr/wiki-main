import type { Editor } from "@tiptap/core";
import type { Extension, Node, Mark } from "@tiptap/core";
import type React from "react";

// ---------------------------------------------------------------------------
// Plugin registration definitions. Every def is a plain object with
// callback functions — no bare imports needed in the plugin bundle. The host
// provides React and Tiptap constructors via the PluginAPI.
// ---------------------------------------------------------------------------

export interface SlashCommandDef {
  name: string;
  label: string;
  icon?: string;
  keywords?: string[];
  run: (editor: Editor) => void;
}

export interface ToolbarItemDef {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onPress: (editor: Editor) => void;
  isActive?: (editor: Editor) => boolean;
  group?: string;
}

export interface SettingsPanelDef {
  id: string;
  label: string;
  render: (props: { pluginId: string }) => React.ReactNode;
}

export interface EmbedTypeDef {
  name: string;
  label: string;
  icon?: string;
  placeholder?: string;
  renderReadOnly?: (attrs: Record<string, unknown>) => React.ReactNode;
  renderEditor?: (attrs: Record<string, unknown>, editor: Editor) => React.ReactNode;
}

export interface TiptapAPI {
  Extension: typeof Extension;
  Node: typeof Node;
  Mark: typeof Mark;
}
