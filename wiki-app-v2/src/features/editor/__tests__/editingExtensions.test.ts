import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import { baseExtensions } from "../editorExtensions.js";
import { editingExtensions } from "../editingExtensions.js";

/**
 * §6.2 structural guard. The drag handle and dropcursor are ProseMirror
 * *plugins* — they render chrome around the document, never content. This test
 * proves they add no nodes/marks to the schema, so by construction they can
 * never be inserted as a wrapping parent of editor content (the §6.1 bug was
 * exactly that: a wrapping DOM element used to anchor UI).
 */
describe("editingExtensions (drag handle + dropcursor) add no schema content", () => {
  it("does not add any node or mark types beyond baseExtensions", () => {
    const base = getSchema(baseExtensions());
    const withEditing = getSchema([...baseExtensions(), ...editingExtensions()]);

    expect(Object.keys(withEditing.nodes).sort()).toEqual(
      Object.keys(base.nodes).sort(),
    );
    expect(Object.keys(withEditing.marks).sort()).toEqual(
      Object.keys(base.marks).sort(),
    );
  });

  it("registers the drag-handle plugin (dropcursor is provided by StarterKit)", () => {
    const extensions = editingExtensions();
    const names = extensions.map((e) => e.name).sort();
    expect(names).toEqual(["globalDragHandle"]);
  });
});
