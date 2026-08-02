import GlobalDragHandle from "./vendor/drag-handle.js";
import SearchAndReplace from "./vendor/search-and-replace.js";

/**
 * Editing-only extensions (Phase 2, §7.13): ProseMirror plugins that drive
 * chrome around the document rather than content itself. Deliberately separate
 * from baseExtensions so the read-only ShareView and the server's collab-seed
 * schema never load them (they add no nodes, but the drag handle touches the
 * DOM and neither read-only rendering nor schema building needs it).
 */

export function editingExtensions() {
  return [
    GlobalDragHandle.configure({
      dragHandleWidth: 20,
    }),
    SearchAndReplace.configure({
      searchResultClass: "search-result",
    }),
  ];
}
