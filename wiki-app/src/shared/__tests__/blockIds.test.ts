import { describe, it, expect } from "vitest";
import {
  ensureBlockIds,
  collectBlockIds,
  blockRangeForId,
  blockIdAtPosition,
  isBlockType,
  defaultGenerateId,
  type JSONBlock,
} from "../blockIds.js";

function doc(content: JSONBlock[]): JSONBlock {
  return { type: "doc", content };
}

const sample = (): JSONBlock =>
  doc([
    { type: "heading", attrs: { level: 1, id: "h1" }, content: [{ type: "text", text: "Title" }] },
    {
      type: "bulletList",
      attrs: { id: "list" },
      content: [
        {
          type: "listItem",
          attrs: { id: "li1" },
          content: [{ type: "paragraph", attrs: { id: "p-inner" }, content: [{ type: "text", text: "one" }] }],
        },
      ],
    },
    { type: "paragraph", attrs: { id: "p3" }, content: [{ type: "text", text: "three" }] },
  ]);

describe("isBlockType", () => {
  it("treats doc and inline types as non-block", () => {
    expect(isBlockType("doc")).toBe(false);
    expect(isBlockType("text")).toBe(false);
    expect(isBlockType("hardBreak")).toBe(false);
    expect(isBlockType("paragraph")).toBe(true);
    expect(isBlockType("heading")).toBe(true);
    expect(isBlockType("bulletList")).toBe(true);
    expect(isBlockType("image")).toBe(true); // block-level image
  });
});

describe("ensureBlockIds", () => {
  it("assigns ids to every block node missing one, preserving existing ids", () => {
    const input = doc([
      { type: "paragraph", content: [{ type: "text", text: "a" }] },
      { type: "paragraph", attrs: { id: "keep" }, content: [{ type: "text", text: "b" }] },
    ]);
    const out = ensureBlockIds(input, () => "gen");
    expect(out.content?.[0]?.attrs?.id).toBe("gen");
    expect(out.content?.[1]?.attrs?.id).toBe("keep");
  });

  it("does not mutate the input tree", () => {
    const input = doc([{ type: "paragraph", content: [{ type: "text", text: "a" }] }]);
    ensureBlockIds(input);
    expect(input.content?.[0]?.attrs).toBeUndefined();
  });

  it("is idempotent - re-running leaves ids untouched", () => {
    const once = ensureBlockIds(sample(), () => "x");
    const twice = ensureBlockIds(once);
    expect(twice).toEqual(once);
  });

  it("assigns unique ids to sibling blocks", () => {
    const out = ensureBlockIds(doc([{ type: "paragraph" }, { type: "paragraph" }]));
    const ids = out.content?.map((b) => b.attrs?.id) ?? [];
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBeTruthy();
  });
});

describe("collectBlockIds", () => {
  it("returns ids in document order", () => {
    expect(collectBlockIds(sample())).toEqual(["h1", "list", "li1", "p-inner", "p3"]);
  });

  it("returns empty for a doc without ids", () => {
    expect(collectBlockIds(doc([{ type: "paragraph" }]))).toEqual([]);
  });
});

describe("blockRangeForId", () => {
  it("computes correct ProseMirror ranges", () => {
    // doc = [heading "Title", bulletList [listItem [para "one"]], para "three"]
    // positions: h1 start=1, text [2,7) => h1 [1,8)
    //            list start=8, li1 start=9, para start=10, "one" [11,14),
    //            para [10,15), li1 [9,16), list [8,17)
    //            p3 start=17, "three" [18,23), p3 [17,24)
    const r = blockRangeForId(sample(), "p3");
    expect(r).toEqual({ from: 17, to: 24 });
  });

  it("returns the whole subtree range for a nested block", () => {
    const r = blockRangeForId(sample(), "li1");
    expect(r).toEqual({ from: 9, to: 16 });
  });

  it("returns null when the block is missing", () => {
    expect(blockRangeForId(sample(), "nope")).toBeNull();
  });
});

describe("blockIdAtPosition", () => {
  it("finds the deepest block containing a position", () => {
    // inside the listItem's inner paragraph text -> deepest id'd block is p-inner
    expect(blockIdAtPosition(sample(), 12)).toBe("p-inner");
    // inside the heading text
    expect(blockIdAtPosition(sample(), 3)).toBe("h1");
    // at the very start of a block's content (before its text)
    expect(blockIdAtPosition(sample(), 18)).toBe("p3");
  });

  it("returns null for a position outside any block", () => {
    expect(blockIdAtPosition(sample(), 0)).toBeNull();
    expect(blockIdAtPosition(sample(), 100)).toBeNull();
  });
});

describe("defaultGenerateId", () => {
  it("produces distinct, well-formed ids", () => {
    const a = defaultGenerateId();
    const b = defaultGenerateId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(a).not.toBe(b);
  });
});
