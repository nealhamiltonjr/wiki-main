import type { Editor as TiptapEditor } from "@tiptap/core";
import type { AnyExtension } from "@tiptap/core";

// ---------------------------------------------------------------------------
// Plugin Engine — the central registration surface for editor plugins.
//
// Every plugin (and every core feature that wants to prove the surface is
// sound) goes through the same register*() calls. Nothing calls Tiptap's
// editor.extensionManager directly — the engine is the single source of
// truth for what's registered.
// ---------------------------------------------------------------------------

// -- Slash commands ----------------------------------------------------------

export interface SlashCommand {
  /** Unique identifier, e.g. "heading1" */
  name: string;
  /** Group for the suggestion menu, e.g. "Headings" */
  group: string;
  /** Display label in the suggestion menu */
  label: string;
  /** Single emoji or short icon string */
  icon?: string;
  /** Optional helper text shown below the label */
  description?: string;
  /** Extra keywords matched by the filter (e.g. "table", "toc") so queries that
   *  don't literally appear in the label still surface the command */
  searchTerms?: string[];
  /** Executed when the user picks this command from the menu */
  command: (opts: { editor: TiptapEditor }) => void;
}

const slashCommands: SlashCommand[] = [];

export function registerSlashCommand(cmd: SlashCommand): void {
  slashCommands.push(cmd);
}

export function getSlashCommands(): SlashCommand[] {
  return slashCommands;
}

// -- Toolbar buttons ---------------------------------------------------------

export interface ToolbarButton {
  /** Unique name, e.g. "bold" */
  name: string;
  /** Display content (emoji or short text) */
  label: string;
  /** Tooltip */
  title?: string;
  /** Visual group — buttons in the same group sit together with separators between groups */
  group?: string;
  /** Called on every render to determine active highlight state */
  isActive: (editor: TiptapEditor) => boolean;
  /** Called on click */
  onClick: (editor: TiptapEditor) => void;
}

const toolbarButtons: ToolbarButton[] = [];

export function registerToolbarButton(btn: ToolbarButton): void {
  toolbarButtons.push(btn);
}

export function getToolbarButtons(): ToolbarButton[] {
  return toolbarButtons;
}

// -- Editor extensions -------------------------------------------------------

const editorExtensions: AnyExtension[] = [];

export function registerEditorExtension(ext: AnyExtension): void {
  editorExtensions.push(ext);
}

export function getEditorExtensions(): AnyExtension[] {
  return editorExtensions;
}
