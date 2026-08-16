import { describe, it, expect } from "vitest";
import { highlightCode } from "../codeHighlight.js";

describe("highlightCode", () => {
  it("returns escaped, tokenized HTML for a known language", async () => {
    const html = await highlightCode("echo hello", "bash");
    expect(html).toBeTypeOf("string");
    expect(html).toContain("token");
    expect(html).toContain("echo");
  });
  it("returns null when no language is supplied", async () => {
    expect(await highlightCode("code", null)).toBeNull();
    expect(await highlightCode("code", undefined)).toBeNull();
  });
  it("does not emit raw text as HTML (source text is escaped)", async () => {
    const html = await highlightCode("<script>alert(1)</script>", "html");
    expect(html).toBeTypeOf("string");
    expect(html).not.toContain("<script>");
  });
  it("caches the Prism core across calls", async () => {
    await highlightCode("x = 1", "python");
    const t0 = Date.now();
    await highlightCode("y = 2", "python");
    expect(Date.now() - t0).toBeLessThan(50);
  });
  it("falls back to plaintext for an unknown language", async () => {
    const html = await highlightCode("some code", "totally-made-up-language-xyz");
    expect(html).toBeTypeOf("string");
    expect(html).toContain("some code");
  });
});
