import { describe, it, expect } from "vitest";
import { computeSlashQuery } from "../SlashMenu.js";

// computeSlashQuery works on a shape-compatible subset of a ProseMirror
// transaction — resolve(pos) must return { parent: { textContent }, parentOffset }.
function tr(textContent: string, parentOffset: number, selectionFrom: number) {
  return {
    doc: {
      resolve: () => ({ parent: { textContent }, parentOffset }),
    },
    selection: { from: selectionFrom },
  } as Parameters<typeof computeSlashQuery>[0];
}

describe("computeSlashQuery", () => {
  it("extracts the query after the slash at line start", () => {
    // paragraph("/web"), caret after "web" → query "web", delete range = /web.
    expect(computeSlashQuery(tr("/web", 4, 4))).toEqual({ query: "web", range: { from: 1, to: 4 } });
  });

  it("extracts the query when an atom shifted the slash (drawio embed at pos 0)", () => {
    // Paragraph sits AFTER an atom node, so its textContent is just "/web".
    // The "/" occupies the paragraph's own start — range must still cover
    // exactly "/web" (here mapped to doc positions 1..5).
    expect(computeSlashQuery(tr("/web", 4, 5))).toEqual({ query: "web", range: { from: 2, to: 5 } });
  });

  it("extracts the query after whitespace within a paragraph", () => {
    // paragraph("hello /web"), caret after "web" → query "web", only "/web" deleted.
    expect(computeSlashQuery(tr("hello /web", 10, 10))).toEqual({ query: "web", range: { from: 7, to: 10 } });
  });

  it("yields an empty query when the block holds only the slash", () => {
    expect(computeSlashQuery(tr("/", 1, 1))).toEqual({ query: "", range: { from: 1, to: 1 } });
  });

  it("keeps a partial query while typing mid-word", () => {
    expect(computeSlashQuery(tr("/webcli", 7, 7))).toEqual({ query: "webcli", range: { from: 1, to: 7 } });
  });

  it("does not strip a non-slash-leading block when backspaced past the slash", () => {
    expect(computeSlashQuery(tr("web", 3, 3))).toEqual({ query: "web", range: { from: 1, to: 3 } });
  });
});
