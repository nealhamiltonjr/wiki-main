import { Node, mergeAttributes } from "@tiptap/core";

/**
 * Inline image node (§9.4 "upload an image — it renders inline").
 *
 * The server markdown round-trip already emits `{ type: "image", attrs:
 * { src, alt } }`, and `shared/blockIds` sanitizes the src at persist time.
 * This node only fills the missing editor-schema half so an uploaded image can
 * be inserted (and re-rendered) without a dependency on @tiptap/extension-image.
 */
export const Image = Node.create({
  name: "image",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { loading: "lazy" })];
  },
});
