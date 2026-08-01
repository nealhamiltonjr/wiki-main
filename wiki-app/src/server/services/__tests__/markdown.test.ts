import { describe, it, expect } from "vitest";
import { tiptapToMarkdown } from "../markdown.service.js";

describe("tiptapToMarkdown", () => {
  it("converts a realistic document with headings, marks, lists, and code blocks", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Proxmox Setup" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "This covers the " },
            { type: "text", text: "base", marks: [{ type: "bold" }] },
            { type: "text", text: " install and " },
            { type: "text", text: "networking docs", marks: [{ type: "link", attrs: { href: "../network/setup.md" } }] },
            { type: "text", text: "." },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Install ISO" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Configure network bridge" }] }] },
          ],
        },
        { type: "codeBlock", attrs: { language: "bash" }, content: [{ type: "text", text: "pveversion" }] },
      ],
    };

    const md = tiptapToMarkdown(doc as any);
    expect(md).toContain("# Proxmox Setup");
    expect(md).toContain("**base**");
    expect(md).toContain("[networking docs](../network/setup.md)");
    expect(md).toContain("- Install ISO");
    expect(md).toContain("```bash\npveversion\n```");
  });

  it("returns an empty string for an empty document rather than throwing", () => {
    expect(tiptapToMarkdown({ type: "doc", content: [] } as any)).toBe("\n");
  });

  it("degrades unknown node types to their inline text instead of dropping them", () => {
    const doc = {
      type: "doc",
      content: [{ type: "someFutureNodeType", content: [{ type: "text", text: "still readable" }] }],
    };
    expect(tiptapToMarkdown(doc as any)).toContain("still readable");
  });
});
