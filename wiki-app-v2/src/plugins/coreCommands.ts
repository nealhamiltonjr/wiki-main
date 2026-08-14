import { registerMermaidSlashCommand } from "@/features/editor/extensions/mermaidSlashCommand.js";

/**
 * Registers every first-party slash command (§13.6). Mermaid is the only
 * core command today; new first-class content types (e.g., a divider, a
 * callout, a code-page shortcut) get a registerXxxSlashCommand() here.
 *
 * Called from loadPlugins() — which means the commands are guaranteed to be
 * in the registry BEFORE any editor mounts (the slash menu is empty if you
 * try to open it before plugins load, and the editor schema is built once,
 * so a late registration would miss the first user).
 */
export function registerCoreCommands(): void {
  registerMermaidSlashCommand();
}