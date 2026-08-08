import { Node, mergeAttributes } from "@tiptap/react";

/**
 * Tiptap node extension for Mermaid diagrams (§13.6).
 *
 * Stores diagram source text as the node's only child (a text node). In edit
 * mode, renders as a bordered pre/code block where the user edits the diagram
 * source. In read mode, the ReadOnlyContent renderer in $branchId.tsx detects
 * nodes of type "mermaidDiagram" and renders them with the Mermaid library.
 *
 * The content validation whitelist (blockIds.ts) must include this type.
 */

export const MermaidNode = Node.create({
  name: "mermaidDiagram",
  group: "block",
  content: "text*",
  defining: true,
  isolating: true,
  selectable: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute("data-id") },
    };
  },

  parseHTML() {
    return [{ tag: "pre[data-mermaid]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "pre",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-mermaid": "",
        "data-id": HTMLAttributes.id ?? "",
      }),
      ["code", {}, 0],
    ];
  },
});
