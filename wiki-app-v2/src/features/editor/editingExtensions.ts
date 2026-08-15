import GlobalDragHandle from "./extensions/dragHandle.js";

/**
 * Editing-only extensions (§7.13): ProseMirror plugins that drive chrome
 * around the document rather than content itself. Deliberately separate from
 * baseExtensions so the server's collab-seed schema never loads them — they
 * add no nodes/marks, but the drag handle touches the DOM and neither
 * read-only rendering nor schema building needs it.
 *
 * The handle selects a block (NodeSelection), StarterKit's dropcursor draws
 * the drop-position line (configured in baseExtensions), and native
 * ProseMirror DnD (plus the handle's handleDOMEvents.drop for list-item edges)
 * completes the move. The handle is a SIBLING of the ProseMirror root,
 * appended to .editor-canvas and positioned with absolute coordinates — never
 * a wrapping element (§6.2).
 */
export function editingExtensions() {
  return [
    GlobalDragHandle.configure({
      dragHandleWidth: 20,
    }),
  ];
}
