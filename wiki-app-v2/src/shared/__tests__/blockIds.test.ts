import { describe, it, expect } from "vitest";
import { validateContent, ensureBlockIds, collectBlockIds, safeLinkHref, safeImageSrc, filterUnknownNodes, KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES } from "../blockIds.js";
import type { JSONBlock } from "../blockIds.js";

describe("validateContent", () => {
  it("accepts a valid doc", () => {
    const { doc, errors } = validateContent({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(doc.type).toBe("doc");
    expect(errors.filter((e) => e.includes("unknown node type"))).toHaveLength(0);
  });

  it("auto-wraps a non-doc root", () => {
    const { doc, errors } = validateContent({ type: "paragraph" });
    expect(doc.type).toBe("doc");
    expect(doc.content?.[0]?.type).toBe("paragraph");
    expect(errors).toContainEqual(expect.stringContaining("auto-wrapped"));
  });

  it("auto-fills empty content", () => {
    const { doc, errors } = validateContent({ type: "doc", content: [] });
    expect(doc.content).toHaveLength(1);
    expect(doc.content?.[0]?.type).toBe("paragraph");
    expect(errors).toContainEqual(expect.stringContaining("auto-filled"));
  });

  it("rejects unknown block types (Word paste attack)", () => {
    const { errors } = validateContent({
      type: "doc",
      content: [{ type: "span", content: [{ type: "text", text: "styled" }] }],
    });
    expect(errors.some((e) => e.includes("unknown node type"))).toBe(true);
    expect(errors.some((e) => e.includes("span"))).toBe(true);
  });

  it("rejects unknown mark types", () => {
    const { errors } = validateContent({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "styled", marks: [{ type: "fontSize", attrs: { size: 72 } }] }],
      }],
    });
    expect(errors.some((e) => e.includes("unknown mark type"))).toBe(true);
  });

  it("auto-assigns ids to blocks missing them", () => {
    const { doc, errors } = validateContent({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "No ID" }] },
        { type: "paragraph" },
      ],
    });
    expect(doc.content?.[0]?.attrs?.id).toBeDefined();
    expect(doc.content?.[1]?.attrs?.id).toBeDefined();
    expect(errors.some((e) => e.includes("missing id"))).toBe(true);
  });

  it("handles null input gracefully", () => {
    const { doc, errors } = validateContent(null);
    expect(doc.type).toBe("doc");
    expect(doc.content).toBeDefined();
    expect(errors).toContainEqual(expect.stringContaining("empty"));
  });
});

describe("ensureBlockIds + collectBlockIds", () => {
  it("assigns ids to every block in a tree", () => {
    const out = ensureBlockIds({
      type: "doc",
      content: [{ type: "paragraph" }, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "H2" }] }],
    });
    const ids = collectBlockIds(out);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && id.length === 12)).toBe(true);
  });
});

describe("safeLinkHref + link sanitization", () => {
  it("keeps safe schemes and relative/fragment hrefs", () => {
    expect(safeLinkHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeLinkHref("http://example.com/x")).toBe("http://example.com/x");
    expect(safeLinkHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(safeLinkHref("/api/branches/abc/page")).toBe("/api/branches/abc/page");
    expect(safeLinkHref("#section")).toBe("#section");
    expect(safeLinkHref("example.com/path")).toBe("example.com/path"); // no scheme = fine
  });

  it("neutralizes script-capable schemes", () => {
    expect(safeLinkHref("javascript:alert(1)")).toBe("#");
    expect(safeLinkHref("  JAVASCRIPT:alert(1)  ")).toBe("#");
    expect(safeLinkHref("data:text/html,<script>")).toBe("#");
    expect(safeLinkHref("vbscript:msgbox(1)")).toBe("#");
  });

  it("auto-repairs unsafe link hrefs during validation", () => {
    const input = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [
            { type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
          ],
        },
      ],
    };
    const { doc, errors } = validateContent(input);
    const docBlock = (doc.content as unknown[])[0] as { content?: unknown[] };
    const paragraph = (docBlock.content as unknown[])[0] as { marks?: unknown[] };
    const mark = (paragraph.marks as unknown[])[0] as { attrs?: { href?: string } };
    expect(mark.attrs?.href).toBe("#");
    expect(errors.some((e) => e.includes("unsafe link scheme"))).toBe(true);
  });
});

describe("safeImageSrc + image sanitization", () => {
  it("keeps safe schemes and relative/fragment srcs", () => {
    expect(safeImageSrc("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(safeImageSrc("http://example.com/x.png")).toBe("http://example.com/x.png");
    expect(safeImageSrc("/api/files/abc/image.png")).toBe("/api/files/abc/image.png");
    expect(safeImageSrc("#poster")).toBe("#poster");
    expect(safeImageSrc("example.com/x.png")).toBe("example.com/x.png"); // no scheme = fine
  });

  it("neutralizes script-capable schemes to empty string", () => {
    expect(safeImageSrc("javascript:alert(1)")).toBe("");
    expect(safeImageSrc("  JAVASCRIPT:alert(1)  ")).toBe("");
    expect(safeImageSrc("vbscript:msgbox(1)")).toBe("");
    expect(safeImageSrc("file:///etc/passwd")).toBe("");
  });

  it("neutralizes data: URLs (SVG can carry script, text/html can carry script, application/xml can carry XXE)", () => {
    expect(safeImageSrc("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(safeImageSrc("data:image/svg+xml,<svg onload='alert(1)'/>")).toBe("");
    expect(safeImageSrc("data:application/xml,<x/>")).toBe("");
    // Even "safe-looking" image data URLs are blocked — inline data: is a
    // niche feature the wiki doesn't need (use file upload instead), and
    // blocking all of them shrinks the attack surface.
    expect(safeImageSrc("data:image/png;base64,AAAA")).toBe("");
  });

  it("auto-repairs unsafe image srcs during validation", () => {
    const input = {
      type: "doc",
      content: [
        { type: "image", attrs: { id: "im1", src: "javascript:alert(1)", alt: "x" } },
      ],
    };
    const { doc, errors } = validateContent(input);
    const img = (doc.content as unknown[])[0] as { attrs?: { src?: string } };
    expect(img.attrs?.src).toBe("");
    expect(errors.some((e) => e.includes("unsafe image src"))).toBe(true);
  });

  it("preserves a safe image src unchanged during validation", () => {
    const input = {
      type: "doc",
      content: [
        { type: "image", attrs: { id: "im1", src: "https://example.com/x.png", alt: "x" } },
      ],
    };
    const { errors } = validateContent(input);
    expect(errors.some((e) => e.includes("unsafe image src"))).toBe(false);
  });
});

describe("filterUnknownNodes", () => {
  it("preserves known block types", () => {
    const doc: JSONBlock = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    };
    const result = filterUnknownNodes(doc, KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES);
    expect(result.content).toHaveLength(1);
    const p = result.content![0] as JSONBlock;
    expect(p.type).toBe("paragraph");
  });

  it("converts unknown block nodes to paragraphs preserving text", () => {
    const doc: JSONBlock = {
      type: "doc",
      content: [{ type: "drawioDiagram", attrs: { foo: 1 }, content: [{ type: "text", text: "some text" }] }],
    };
    const result = filterUnknownNodes(doc, KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES);
    expect(result.content).toHaveLength(1);
    const p = result.content![0] as JSONBlock;
    expect(p.type).toBe("paragraph");
    const text = p.content?.[0] as { text?: string };
    expect(text.text).toBe("some text");
  });

  it("converts nested unknown blocks recursively", () => {
    const doc: JSONBlock = {
      type: "doc",
      content: [{
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "drawioDiagram", content: [{ type: "text", text: "nested" }] }] }],
      }],
    };
    const result = filterUnknownNodes(doc, KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES);
    const bulletList = result.content?.[0] as JSONBlock | undefined;
    expect(bulletList?.type).toBe("bulletList");
    const listItem = bulletList?.content?.[0] as JSONBlock | undefined;
    expect(listItem?.type).toBe("listItem");
    expect(listItem?.content?.[0]?.type).toBe("paragraph"); // was drawioDiagram
    const textNode = listItem?.content?.[0] as JSONBlock | undefined;
    const text = textNode?.content?.[0] as { text?: string } | undefined;
    expect(text?.text).toBe("nested");
  });

  it("filters unknown marks from inline nodes", () => {
    const doc: JSONBlock = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "bold" }, { type: "fancyGlow" }] }] }],
    };
    const result = filterUnknownNodes(doc, KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES);
    const textNode = (result.content?.[0] as JSONBlock | undefined)?.content?.[0] as { marks?: { type: string }[] } | undefined;
    expect(textNode?.marks).toHaveLength(1);
    expect(textNode?.marks?.[0]?.type).toBe("bold");
  });

  it("accepts plugin node types when in the allowed set", () => {
    const block = new Set([...KNOWN_BLOCK_TYPES, "pluginDiagram"]);
    const doc: JSONBlock = {
      type: "doc",
      content: [{ type: "pluginDiagram", attrs: { x: 1 } }],
    };
    const result = filterUnknownNodes(doc, block, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES);
    expect(result.content?.[0]?.type).toBe("pluginDiagram");
  });

  it("handles empty content gracefully", () => {
    const doc: JSONBlock = { type: "doc", content: [] };
    const result = filterUnknownNodes(doc, KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES);
    expect(result.type).toBe("doc");
    expect(Array.isArray(result.content)).toBe(true);
    // Empty doc maps to empty content — no repair needed.
  });
});
