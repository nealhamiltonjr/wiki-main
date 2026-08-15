import { registerMermaidSlashCommand } from "@/features/editor/extensions/mermaidSlashCommand.js";
import { registerBlocksSlashCommands } from "@/features/editor/extensions/blocksSlashCommands.js";

/**
 * Registers every first-party slash command (§13.6). Mermaid is the only
 * core command today; new first-class content types (e.g., a divider, a
 * callout, a code-page shortcut) get a registerXxxSlashCommand() here.
 *
 * Called from loadPlugins() — which means the commands are guaranteed to be
 * in the registry BEFORE any editor mounts (the slash menu is empty if you
 * try to open it before plugins load, and the editor schema is built once,
 * so a late registration would miss the first user).
 *
 * Slice-46: idempotent within a single page-load — the registry now rejects
 * duplicate slash-command names, so a second call would throw. The boot
 * loader's own `if (_loaded) return;` guard prevents that, but tests
 * sometimes call this twice in the same module; the per-command guards here
 * keep those tests from throwing.
 */
export function registerCoreCommands(): void {
  registerMermaidSlashCommandIfNeeded();
  registerBlocksSlashCommands();
}

function registerMermaidSlashCommandIfNeeded(): void {
  // Defer to the imported helper but swallow the duplicate-name throw when
  // it happens. The first call always wins; subsequent calls are no-ops.
  try {
    registerMermaidSlashCommand();
  } catch (err) {
    if (!(err instanceof Error) || !/already registered/.test(err.message)) throw err;
  }
}
