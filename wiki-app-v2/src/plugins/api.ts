import { Extension, Node, Mark } from "@tiptap/core";
import type { AnyExtension } from "@tiptap/core";
import React from "react";
import type { PluginCapabilities } from "@/shared/pluginTypes";
import type { TiptapAPI } from "./defs.js";
import {
  registerTiptapExtension as regExt,
  registerSlashCommand as regSlash,
  registerToolbarItem as regToolbar,
  registerSettingsPanel as regSettings,
  registerEmbedType as regEmbed,
} from "./registry.js";
import type { SlashCommandDef, ToolbarItemDef, SettingsPanelDef, EmbedTypeDef } from "./defs.js";

/**
 * The PluginAPI — what a plugin's register(api) function receives. Every
 * registration method checks the manifest's declared capabilities first; a
 * call to an undeclared capability throws (§4.4 contract enforcement).
 */
export interface PluginAPI {
  /** Host-provided Tiptap constructors. Plugins call e.g. api.Tiptap.Node.create({...}). */
  Tiptap: TiptapAPI;
  /** Host-provided React — for settings panels, NodeViews, embed renderers. */
  React: typeof React;
  registerTiptapExtension(ext: AnyExtension): void;
  registerSlashCommand(def: SlashCommandDef): void;
  registerToolbarItem(def: ToolbarItemDef): void;
  registerSettingsPanel(def: SettingsPanelDef): void;
  registerEmbedType(def: EmbedTypeDef): void;
}

export function createPluginAPI(manifest: PluginCapabilities): PluginAPI {
  const guard = (capability: string, fn: () => void) => {
    if (!(manifest as unknown as Record<string, boolean>)[capability]) {
      throw new Error(`Plugin attempted to call register${capability.charAt(0).toUpperCase() + capability.slice(1)}() but ${capability} is not declared in its manifest`);
    }
    fn();
  };

  return {
    Tiptap: { Extension, Node, Mark },
    React,
    registerTiptapExtension(ext) {
      guard("tiptapExtensions", () => regExt(ext));
    },
    registerSlashCommand(def) {
      guard("slashCommands", () => regSlash(def));
    },
    registerToolbarItem(def) {
      guard("toolbarItems", () => regToolbar(def));
    },
    registerSettingsPanel(def) {
      guard("settingsPanel", () => regSettings(def));
    },
    registerEmbedType(def) {
      guard("embedTypes", () => regEmbed(def));
    },
  };
}
