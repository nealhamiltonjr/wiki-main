import { Node, mergeAttributes } from "@tiptap/core";

export const Image = Node.create({
  name: "image", group: "inline", inline: true, atom: true, draggable: true, selectable: true,
  addAttributes() {
    return {
      src: { default: null }, alt: { default: null }, title: { default: null },
      width: { default: null }, height: { default: null },
    };
  },
  parseHTML() { return [{ tag: "img[src]" }]; },
  renderHTML({ HTMLAttributes }) {
    const extras: Record<string, string> = { loading: "lazy" };
    if (HTMLAttributes.width != null) extras.width = String(HTMLAttributes.width);
    if (HTMLAttributes.height != null) extras.height = String(HTMLAttributes.height);
    return ["img", mergeAttributes(HTMLAttributes, extras)];
  },
});
