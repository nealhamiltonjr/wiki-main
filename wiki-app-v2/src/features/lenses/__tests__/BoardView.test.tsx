import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) =>
    createElement("a", rest as Record<string, unknown>, children),
}));

const { BoardView } = await import("../BoardView");
import type { LensHit } from "../../../api/client";

const H = (
  pageId: string,
  title: string,
  promotedAttributes: Array<{ name: string; value: string; own: boolean }> = [],
): LensHit => ({
  pageId, title,
  slug: title.toLowerCase().replace(/\s+/g, "-"),
  spaceId: "s", spaceName: "Space",
  ownerId: null, branchId: `b-${pageId}`, isTrashed: false,
  promotedAttributes,
});

const render = (ui: React.ReactNode) => renderToStaticMarkup(ui);

describe("BoardView (slice-29, brief §13.4)", () => {
  it("renders an empty-state when there are no hits", () => {
    const html = render(createElement(BoardView, { hits: [], groupBy: "status" }));
    expect(html).toContain("No pages match this lens.");
  });

  it("renders one column per distinct value of the groupBy attribute", () => {
    const html = render(createElement(BoardView, {
      groupBy: "status",
      hits: [
        H("1", "a", [{ name: "status", value: "draft", own: true }]),
        H("2", "b", [{ name: "status", value: "published", own: true }]),
        H("3", "c", [{ name: "status", value: "draft", own: true }]),
      ],
    }));
    expect(html).toContain("draft");
    expect(html).toContain("published");
  });

  it("places hits missing the groupBy attribute in a (none) column", () => {
    const html = render(createElement(BoardView, {
      groupBy: "status",
      hits: [
        H("1", "a", [{ name: "status", value: "draft", own: true }]),
        H("2", "b"),
      ],
    }));
    expect(html).toContain("(none)");
  });

  it("renders the count badge per column", () => {
    const html = render(createElement(BoardView, {
      groupBy: "status",
      hits: [
        H("1", "a", [{ name: "status", value: "draft", own: true }]),
        H("2", "b", [{ name: "status", value: "draft", own: true }]),
        H("3", "c", [{ name: "status", value: "draft", own: true }]),
      ],
    }));
    // Three items in the draft column → "3" appears at least once in the column header.
    const draft = html.indexOf("draft");
    expect(draft).toBeGreaterThan(-1);
    expect(html.slice(draft, draft + 80)).toContain("3");
  });
});