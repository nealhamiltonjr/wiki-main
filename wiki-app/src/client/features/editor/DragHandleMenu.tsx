import { useEffect } from "react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Block-action menu shown when clicking the drag handle (Phase 2). The handle
 * itself is provided by the vendored GlobalDragHandle extension
 * (vendor/drag-handle.ts); this menu owns the keyboard-free actions on the
 * hovered top-level block: insert below, duplicate, move up/down, delete.
 */

export interface BlockAnchor {
  from: number;
  to: number;
  node: PMNode;
}

/** Top-level block (depth 1) containing `pos`, or null. */
export function blockAtPos(editor: TiptapEditor, pos: number): BlockAnchor | null {
  const doc = editor.state.doc;
  const resolved = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if (resolved.depth < 1) return null;
  return { from: resolved.before(1), to: resolved.after(1), node: resolved.node(1) };
}

/** Removes the `id` attribute from a block JSON tree (for duplicating). */
function stripIds(json: Record<string, any>): Record<string, any> {
  if (json.attrs) {
    const attrs = { ...json.attrs };
    delete attrs.id;
    json = { ...json, attrs };
  }
  if (Array.isArray(json.content)) {
    json = { ...json, content: json.content.map((c) => stripIds(c)) };
  }
  return json;
}

export const blockActions = {
  addBelow(editor: TiptapEditor, block: BlockAnchor) {
    editor
      .chain()
      .focus()
      .insertContentAt(block.to, { type: "paragraph" })
      .setTextSelection(block.to + 1)
      .run();
  },

  duplicate(editor: TiptapEditor, block: BlockAnchor) {
    const json = stripIds(block.node.toJSON() as Record<string, any>);
    editor.chain().focus().insertContentAt(block.to, json).run();
  },

  delete(editor: TiptapEditor, block: BlockAnchor) {
    // Never leave an empty doc - replace the only block with a fresh paragraph.
    if (editor.state.doc.childCount <= 1) {
      editor
        .chain()
        .focus()
        .setContent({ type: "doc", content: [{ type: "paragraph" }] })
        .run();
      return;
    }
    editor.chain().focus().deleteRange({ from: block.from, to: block.to }).run();
  },

  move(editor: TiptapEditor, block: BlockAnchor, dir: "up" | "down") {
    const doc = editor.state.doc;
    const prev = doc.childBefore(block.from);
    const next = doc.childAfter(block.to);
    const neighbor = dir === "up" ? prev.node : next.node;
    if (!neighbor) return;

    const json = block.node.toJSON(); // keep ids - a moved block keeps its identity
    const schema = editor.state.schema;
    const tr = editor.state.tr;
    let insertAt: number;

    if (dir === "up") {
      // Delete [from,to), then insert the clone before the (unchanged) prev offset.
      insertAt = prev.offset;
    } else {
      // After deletion the block's start position holds the next sibling; insert
      // after it (block.from + neighbor.nodeSize on the pre-deletion numbers).
      insertAt = block.from + neighbor.nodeSize;
    }
    tr.delete(block.from, block.to);
    tr.insert(insertAt, schema.nodeFromJSON(json));
    editor.view.dispatch(tr);
    editor.chain().focus().setTextSelection(insertAt + 1).run();
  },
};

interface Props {
  editor: TiptapEditor;
  block: BlockAnchor;
  x: number;
  y: number;
  onClose: () => void;
}

export function DragHandleMenu({ editor, block, x, y, onClose }: Props) {
  // Close on outside click / Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-drag-menu]") && !target.closest(".drag-handle")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  const itemStyle: React.CSSProperties = {
    padding: "5px 10px",
    borderRadius: 4,
  };

  return (
    <div
      data-drag-menu
      className="wiki-popup"
      style={{
        position: "fixed",
        left: Math.max(4, Math.min(x, window.innerWidth - 170)),
        top: Math.min(y, window.innerHeight - 190),
        zIndex: 1000,
        minWidth: 160,
        padding: 4,
      }}
    >
      <button type="button" className="popup-item" style={itemStyle} onClick={() => { blockActions.addBelow(editor, block); onClose(); }}>
        <span className="popup-icon">➕</span> Add block below
      </button>
      <button type="button" className="popup-item" style={itemStyle} onClick={() => { blockActions.duplicate(editor, block); onClose(); }}>
        <span className="popup-icon">⧉</span> Duplicate
      </button>
      <button type="button" className="popup-item" style={itemStyle} onClick={() => { blockActions.move(editor, block, "up"); onClose(); }}>
        <span className="popup-icon">↑</span> Move up
      </button>
      <button type="button" className="popup-item" style={itemStyle} onClick={() => { blockActions.move(editor, block, "down"); onClose(); }}>
        <span className="popup-icon">↓</span> Move down
      </button>
      <div className="popup-sep" style={{ margin: "4px 6px" }} />
      <button
        type="button"
        className="popup-item"
        style={{ ...itemStyle, color: "var(--color-danger)" }}
        onClick={() => { blockActions.delete(editor, block); onClose(); }}
      >
        <span className="popup-icon">🗑</span> Delete
      </button>
    </div>
  );
}
