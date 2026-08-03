import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import { baseEditorExtensions } from "../../../client/features/editor/baseExtensions.js";

// The editor, the read-only ShareView, and the server's collab seed all build
// their schema from baseEditorExtensions(). If one of them were missing a node
// the others can produce (e.g. the `mention` node), pages containing it would
// fail to parse — rendering as a blank document in that view. This test pins
// the shared schema so that regression stays impossible.
describe("shared editor schema (baseEditorExtensions)", () => {
  it("includes the mention node and parses node-format mention content", () => {
    const schema = getSchema(baseEditorExtensions());
    expect(schema.nodes.mention).toBeTruthy();
    expect(schema.nodes.paragraph).toBeTruthy();

    // What @tiptap/extension-mention emits on save. Must parse cleanly (the
    // collab seed calls prosemirrorJSONToYDoc on exactly this shape).
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "u1", label: "A" } }] }],
    });
    expect(doc.content.child(0).child(0).type.name).toBe("mention");
  });

  it("treats images as inline nodes so markdown-imported images stay valid", () => {
    const schema = getSchema(baseEditorExtensions());

    // The markdown importer stores a standalone `![alt](src)` line as
    // `paragraph > image`, and uploads/links are inserted into the current
    // paragraph. If the image node were block-level (the extension default),
    // that paragraph would be invalid content and any later insert would throw
    // "Called contentMatchAt on a node with invalid content" — silently
    // breaking file uploads on affected pages.
    expect(schema.nodes.image?.isInline).toBe(true);

    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "/api/branches/b/files/f" } }] }],
    });
    expect(doc.content.child(0).content.child(0).type.name).toBe("image");
  });
});
