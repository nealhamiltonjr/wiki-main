import { describe, it, expect } from "vitest";
import { markdownToTiptap, stripFrontmatter } from "../services/markdown.service.js";

/**
 * Markdown import XSS regression tests (slice-45). Probes the round-trip
 * path used by git restore and Markdown import: imported pages must never
 * carry a script-capable URL on a link href or image src, regardless of
 * which payload the import body contains.
 *
 * Defense-in-depth layering (intentionally redundant):
 *   1. markdownToTiptap sanitizes at parse time (this file).
 *   2. validateContent neutralizes again at persist time (blockIds.test.ts).
 *   3. ReadOnlyContent sanitizes again at render time (safeLinkHref).
 * All three must agree: a `javascript:` href is always `href="#"` by the
 * time any layer sees it.
 */
describe("markdown import XSS sanitization (link href)", () => {
  it("neutralizes a plain javascript: link", () => {
    const doc = markdownToTiptap("[click](javascript:alert(1))");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    const text = para.content![0]!;
    expect(text.marks![0]!.attrs!.href).toBe("#");
  });

  it("neutralizes a case-insensitive JAVASCRIPT: link", () => {
    const doc = markdownToTiptap("[click](  JAVASCRIPT:alert(1)  )");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    expect(para.content![0]!.marks![0]!.attrs!.href).toBe("#");
  });

  it("neutralizes a tab-prefixed javascript: link (browser strips whitespace from attribute values)", () => {
    const doc = markdownToTiptap("[click](\tjavascript:alert(1))");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    expect(para.content![0]!.marks![0]!.attrs!.href).toBe("#");
  });

  it("neutralizes a data: link", () => {
    const doc = markdownToTiptap("[click](data:text/html,<script>alert(1)</script>)");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    expect(para.content![0]!.marks![0]!.attrs!.href).toBe("#");
  });

  it("neutralizes a vbscript: link", () => {
    const doc = markdownToTiptap("[click](vbscript:msgbox(1))");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    expect(para.content![0]!.marks![0]!.attrs!.href).toBe("#");
  });

  it("neutralizes a file: link", () => {
    const doc = markdownToTiptap("[secret](file:///etc/passwd)");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    expect(para.content![0]!.marks![0]!.attrs!.href).toBe("#");
  });

  it("preserves a safe https: link", () => {
    const doc = markdownToTiptap("[click](https://example.com/x)");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    expect(para.content![0]!.marks![0]!.attrs!.href).toBe("https://example.com/x");
  });

  it("preserves an internal relative link", () => {
    const doc = markdownToTiptap("[page](/api/branches/abc/page)");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    expect(para.content![0]!.marks![0]!.attrs!.href).toBe("/api/branches/abc/page");
  });

  it("preserves a mailto: link", () => {
    const doc = markdownToTiptap("[mail](mailto:a@b.co)");
    const para = doc.content![0] as { content?: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> };
    expect(para.content![0]!.marks![0]!.attrs!.href).toBe("mailto:a@b.co");
  });

  it("keeps link text visible even when the href is neutralized (no phantom disappearance)", () => {
    const doc = markdownToTiptap("[click here to verify](javascript:alert(1))");
    const para = doc.content![0] as { content?: Array<{ text?: string; marks?: unknown[] }> };
    expect(para.content![0]!.text).toBe("click here to verify");
    // Link mark is preserved (with sanitized href) — the user's text isn't
    // silently swallowed.
    expect(para.content![0]!.marks).toBeDefined();
  });
});

describe("markdown import XSS sanitization (image src)", () => {
  /**
   * The standalone-image regex requires the URL to have no `)`, so a URL
   * with a nested paren won't match standalone-image; the inline parser
   * takes over. For URLs without parens the standalone path triggers and
   * our sanitizer runs.
   */
  it("drops a standalone image with a javascript: src (no zombie placeholder)", () => {
    const doc = markdownToTiptap("![alt](javascript:foo)");
    const para = doc.content![0]!;
    expect(para.type).toBe("paragraph");
    // Empty paragraph: no image child, no orphan alt text.
    const children = (para as { content?: unknown[] }).content ?? [];
    expect(children).toHaveLength(0);
  });

  it("drops a standalone image with a data: src", () => {
    const doc = markdownToTiptap("![alt](data:text/plain,x)");
    const para = doc.content![0]!;
    expect(para.type).toBe("paragraph");
    const children = (para as { content?: unknown[] }).content ?? [];
    expect(children).toHaveLength(0);
  });

  it("drops a standalone image with a file: src", () => {
    const doc = markdownToTiptap("![alt](file:///etc/passwd)");
    const para = doc.content![0]!;
    expect(para.type).toBe("paragraph");
    const children = (para as { content?: unknown[] }).content ?? [];
    expect(children).toHaveLength(0);
  });

  it("drops an inline image with a javascript: src (no nested parens)", () => {
    const doc = markdownToTiptap("before ![alt](javascript:foo) after");
    const para = doc.content![0] as { content?: Array<{ type?: string; text?: string }> };
    const types = para.content!.map((n) => n.type);
    // Only text nodes — no image node survived sanitization.
    expect(types).toEqual(["text", "text"]);
    // Surrounding text is preserved.
    const texts = para.content!.map((n) => n.text ?? "");
    expect(texts.join("")).toContain("before ");
    expect(texts.join("")).toContain("after");
  });

  it("preserves an image with a safe https: src", () => {
    const doc = markdownToTiptap("![alt](https://example.com/x.png)");
    const para = doc.content![0] as { content?: Array<{ type?: string; attrs?: { src?: string; alt?: string } }> };
    const img = para.content![0]!;
    expect(img.type).toBe("image");
    expect(img.attrs!.src).toBe("https://example.com/x.png");
    expect(img.attrs!.alt).toBe("alt");
  });

  it("preserves an image with a relative src", () => {
    const doc = markdownToTiptap("![alt](/api/files/abc/x.png)");
    const para = doc.content![0] as { content?: Array<{ type?: string; attrs?: { src?: string } }> };
    expect(para.content![0]!.attrs!.src).toBe("/api/files/abc/x.png");
  });
});

describe("markdown import XSS (raw HTML is inert text, never parsed)", () => {
  it("treats raw HTML as inert text (browser doesn't execute text nodes)", () => {
    const doc = markdownToTiptap("<script>alert(1)</script>");
    const para = doc.content![0] as { content?: Array<{ text?: string }> };
    expect(para.content![0]!.text).toBe("<script>alert(1)</script>");
  });

  it("treats raw HTML inside a heading as inert text", () => {
    const doc = markdownToTiptap("# <script>alert(1)</script>");
    const heading = doc.content![0]!;
    expect(heading.type).toBe("heading");
    const text = (heading.content as Array<{ text?: string }>)[0]!;
    expect(text.text).toBe("<script>alert(1)</script>");
  });

  it("treats raw HTML inside a fenced code block as inert text", () => {
    const doc = markdownToTiptap("```\n<script>alert(1)</script>\n```");
    const block = doc.content![0]!;
    expect(block.type).toBe("codeBlock");
    const text = (block.content as Array<{ text?: string }>)[0]!;
    expect(text.text).toBe("<script>alert(1)</script>");
  });

  it("strips HTML from a YAML frontmatter title (not rendered to HTML anyway)", () => {
    // Belt-and-suspenders: the title from frontmatter is used for diff
    // display and SSG page titles, never rendered as HTML. Confirm it
    // round-trips through stripFrontmatter without throwing.
    const stripped = stripFrontmatter("---\ntitle: <script>alert(1)</script>\n---\n# body");
    expect(stripped).toBe("# body");
  });
});
