import type { Editor } from "@tiptap/core";

/**
 * Starter template inserted by both the slash command and the toolbar button
 * (§13.6). Deliberately tiny — flowchart with one decision — so the user
 * sees something render and has obvious edit anchors. The starter is a single
 * multiline text node, so the Mermaid extension's "text*" content schema
 * accepts it without special handling. The trailing paragraph after insertion
 * positions the caret on a fresh line so the user can keep typing.
 */
export const MERMAID_STARTER =
  "graph TD\n" +
  "  A[Start] --> B{Is it working?}\n" +
  "  B -->|Yes| C[Great]\n" +
  "  B -->|No| D[Investigate]\n" +
  "  D --> B";

/**
 * Inserts a mermaidDiagram block at the current selection and follows it with
 * an empty paragraph so the caret lands on a new line (otherwise Tiptap
 * leaves the caret inside the just-inserted mermaid atom and the user has to
 * press ArrowDown to keep typing).
 *
 * The parameter is typed as the Tiptap `Editor` for the production call site.
 * Tests pass a structurally-compatible recording mock and cast `as Editor`
 * (or use `unknown` + a single cast) — this is the simplest way to keep the
 * real chain surface fully type-checked without dragging in a giant
 * structural type.
 */
export function insertMermaidDiagram(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .insertContent([
      { type: "mermaidDiagram", content: [{ type: "text", text: MERMAID_STARTER }] },
      { type: "paragraph" },
    ])
    .run();
}