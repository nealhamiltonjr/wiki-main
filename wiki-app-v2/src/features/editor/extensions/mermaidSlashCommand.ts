import { registerSlashCommand } from "@/plugins/registry";
import { insertMermaidDiagram } from "./mermaidInsert.js";

/**
 * Registers the core "Mermaid diagram" slash command (§13.6). Lives outside
 * the plugin engine because Mermaid is a first-class content type per the
 * brief — it must work in any install, not only when a plugin is enabled.
 *
 * `registerCoreCommands()` in src/plugins/coreCommands.ts is the single boot
 * point; do not call this directly from a route or a component.
 */
export function registerMermaidSlashCommand(): void {
  registerSlashCommand({
    name: "mermaid",
    label: "Mermaid diagram",
    keywords: ["diagram", "chart", "flow", "graph", "sequence"],
    icon: "◇",
    run: (editor) => {
      insertMermaidDiagram(editor);
    },
  });
}