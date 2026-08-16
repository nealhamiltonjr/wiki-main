import { Mark, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    wikilink: {
      setWikilink: (attrs: { branchId: string; label?: string }) => ReturnType;
      toggleWikilink: (attrs: { branchId: string; label?: string }) => ReturnType;
      unsetWikilink: () => ReturnType;
    };
  }
}

export const Wikilink = Mark.create({
  name: "wikilink",
  inclusive: false,
  excludes: "wikilink",
  addAttributes() {
    return {
      branchId: { default: null, parseHTML: (el) => el.getAttribute("data-branch-id"), renderHTML: (attrs) => attrs.branchId ? { "data-branch-id": attrs.branchId } : {} },
      label: { default: null, parseHTML: (el) => el.getAttribute("data-label"), renderHTML: (attrs) => attrs.label ? { "data-label": attrs.label } : {} },
    };
  },
  parseHTML() { return [{ tag: "a[data-wikilink]" }, { tag: "a[data-branch-id]" }]; },
  renderHTML({ HTMLAttributes }) {
    const href = HTMLAttributes["data-branch-id"] ? `/w/${HTMLAttributes["data-branch-id"]}` : "#";
    return ["a", mergeAttributes(HTMLAttributes, { "data-wikilink": "true", href, class: "wikilink" }), 0];
  },
  addCommands() {
    return {
      setWikilink: (attrs) => ({ commands }) => commands.setMark(this.name, attrs),
      toggleWikilink: (attrs) => ({ commands }) => commands.toggleMark(this.name, attrs),
      unsetWikilink: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});
