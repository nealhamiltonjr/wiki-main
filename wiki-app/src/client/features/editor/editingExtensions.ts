import { Dropcursor } from "@tiptap/extension-dropcursor";
import GlobalDragHandle from "./vendor/drag-handle.js";
import SearchAndReplace from "./vendor/search-and-replace.js";

/**
 * Editing-only extensions (Phase 2, §7.13): ProseMirror plugins that drive
 * chrome around the document rather than content itself. Deliberately separate
 * from baseExtensions so the read-only ShareView and the server's collab-seed
 * schema never load them (they add no nodes, but the drag handle touches the
 * DOM and neither read-only rendering nor schema building needs it).
 *
 * Dropcursor draws the blue drop-position line during block drag-and-drop via
 * the GlobalDragHandle — the handle selects a block (NodeSelection), the
 * dropcursor renders the indicator at the drop target, and the native
 * ProseMirror DnD machinery (plus handleDOMEvents.drop for list-item edges)
 * completes the move.
 */

export function editingExtensions() {
  return [
    GlobalDragHandle.configure({
      dragHandleWidth: 20,
    }),
    SearchAndReplace.configure({
      searchResultClass: "search-result",
    }),
    Dropcursor.configure({
      width: 2,
      color: "#3b82f6",
    }),
  ];
}
