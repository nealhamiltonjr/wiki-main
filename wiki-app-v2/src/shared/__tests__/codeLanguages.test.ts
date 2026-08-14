import { describe, it, expect } from "vitest";
import { resolveCodeLanguage, codeLanguageExtension } from "../codeLanguages.js";

describe("resolveCodeLanguage", () => {
  it("resolves aliases to a canonical id + extension", () => {
    expect(resolveCodeLanguage("sh")).toMatchObject({ id: "bash", ext: "sh" });
    expect(resolveCodeLanguage("ts")).toMatchObject({ id: "typescript", ext: "ts" });
    expect(resolveCodeLanguage("py")).toMatchObject({ id: "python", ext: "py" });
    expect(resolveCodeLanguage("yml")).toMatchObject({ id: "yaml", ext: "yaml" });
  });

  it("keeps recognized canonical ids as-is", () => {
    expect(resolveCodeLanguage("javascript")).toMatchObject({ id: "javascript", ext: "js" });
    expect(resolveCodeLanguage("json").ext).toBe("json");
  });

  it("falls back to plaintext for null/unknown languages", () => {
    expect(resolveCodeLanguage(null)).toMatchObject({ id: "plaintext", ext: "txt" });
    expect(resolveCodeLanguage(undefined).ext).toBe("txt");
    expect(resolveCodeLanguage("not-a-real-lang").ext).toBe("txt");
  });
});

describe("codeLanguageExtension", () => {
  it("returns the extension without a leading dot", () => {
    expect(codeLanguageExtension("bash")).toBe("sh");
    expect(codeLanguageExtension("typescript")).toBe("ts");
    expect(codeLanguageExtension(null)).toBe("txt");
  });
});
