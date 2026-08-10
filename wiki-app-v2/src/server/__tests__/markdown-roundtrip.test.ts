import { describe, it, expect } from "vitest";
import { tiptapToMarkdown, markdownToTiptap, stripFrontmatter } from "../services/markdown.service.js";

/** doc → markdown → doc → markdown; asserts the git round-trip is lossless. */
function roundTrip(doc: unknown): string {
  const md = tiptapToMarkdown(doc as never);
  const imported = markdownToTiptap(stripFrontmatter(md));
  return tiptapToMarkdown(imported as never);
}

describe("markdown round-trip (git flush restore path)", () => {
  it("keeps ordinary code blocks on a ``` fence", () => {
    const md = tiptapToMarkdown({
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "let x = 1;\n" }] }],
    } as never);
    expect(md).toBe("```js\nlet x = 1;\n\n```\n");
  });

  it("survives a code line that is exactly three backticks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "js" },
          content: [{ type: "text", text: "```\nconst s = `code`;\nreturn 42;\n" }],
        },
      ],
    };
    const md = tiptapToMarkdown(doc as never);
    // The exporter must escape with a LONGER fence (4 backticks), not close early.
    expect(md.startsWith("````js\n")).toBe(true);
    expect(roundTrip(doc)).toBe(md);
  });

  it("survives a longer backtick run than the default fence", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "" },
          content: [{ type: "text", text: "````\nstill inside the block\n" }],
        },
      ],
    };
    const md = tiptapToMarkdown(doc as never);
    expect(roundTrip(doc)).toBe(md);
  });

  it("survives backticks in mermaid sources", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "mermaidDiagram",
          content: [{ type: "text", text: "graph TD\nA[`x`] --> B\n```\nC\n" }],
        },
      ],
    };
    const md = tiptapToMarkdown(doc as never);
    expect(roundTrip(doc)).toBe(md);
  });

  it("survives inline code containing a literal backtick", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "before " },
            { type: "text", text: "a`b`c", marks: [{ type: "code" }] },
            { type: "text", text: " after" },
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(doc as never);
    expect(roundTrip(doc)).toBe(md);
  });
});
