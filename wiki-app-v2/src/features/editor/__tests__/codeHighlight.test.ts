import { describe, it, expect } from "vitest";
import { highlightCode } from "../codeHighlight.js";

describe("highlightCode", () => {
  it("returns escaped, tokenized HTML for a known language", () => {
    const html = highlightCode("echo hello", "bash");
    expect(html).toBeTypeOf("string");
    // Prism wraps tokens in spans and escapes the source text by construction.
    expect(html).toContain("token");
    expect(html).toContain("echo");
  });

  it("returns null when no language is supplied", () => {
    expect(highlightCode("code", null)).toBeNull();
    expect(highlightCode("code", undefined)).toBeNull();
  });

  it("does not emit raw text as HTML (source text is escaped)", () => {
    const html = highlightCode("<script>alert(1)</script>", "html");
    expect(html).toBeTypeOf("string");
    expect(html).not.toContain("<script>");
  });
});
