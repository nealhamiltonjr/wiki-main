import { describe, it, expect } from "vitest";
import { validateContent, ensureBlockIds, collectBlockIds } from "../blockIds.js";

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
