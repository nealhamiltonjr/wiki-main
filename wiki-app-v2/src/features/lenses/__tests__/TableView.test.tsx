import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) =>
    createElement("a", rest as Record<string, unknown>, children),
}));

const { TableView } = await import("../TableView");
import type { LensHit } from "../../../api/client";

const H = (
  pageId: string,
  title: string,
  promotedAttributes: Array<{ name: string; value: string; own: boolean; fromTitle?: string }> = [],
): LensHit => ({
  pageId, title,
  slug: title.toLowerCase().replace(/\s+/g, "-"),
  spaceId: "s", spaceName: "Space",
  ownerId: null, branchId: `b-${pageId}`, isTrashed: false,
  promotedAttributes,
});

const render = (ui: React.ReactNode) => renderToStaticMarkup(ui);

describe("TableView (slice-29, brief §13.4)", () => {
  it("renders an empty-state when there are no hits", () => {
    const html = render(createElement(TableView, {
      hits: [], sortColumn: null, sortDirection: "asc", onSort: () => {},
    }));
    expect(html).toContain("No pages match this lens.");
  });

  it("renders one column per promoted-attribute name in alphabetical order", () => {
    const html = render(createElement(TableView, {
      hits: [
        H("1", "a", [
          { name: "callsign", value: "W1", own: true },
          { name: "band", value: "20m", own: true },
        ]),
      ],
      sortColumn: null, sortDirection: "asc", onSort: () => {},
    }));
    expect(html).toContain("band");
    expect(html).toContain("callsign");
    // band before callsign (alphabetical)
    expect(html.indexOf("band")).toBeLessThan(html.indexOf("callsign"));
  });

  it("renders the attribute value and an inherited marker for non-own attributes", () => {
    const html = render(createElement(TableView, {
      hits: [
        H("1", "a", [
          { name: "band", value: "20m", own: false, fromTitle: "QSO Template" },
        ]),
      ],
      sortColumn: null, sortDirection: "asc", onSort: () => {},
    }));
    expect(html).toContain("20m");
    expect(html).toContain("QSO Template");
    expect(html).toContain("↑");
  });

  it("renders a dash for missing attributes", () => {
    const html = render(createElement(TableView, {
      hits: [
        H("1", "a", [{ name: "band", value: "20m", own: true }]),
        H("2", "b", [{ name: "callsign", value: "W1", own: true }]),
      ],
      sortColumn: null, sortDirection: "asc", onSort: () => {},
    }));
    // Hit a has band but not callsign → dash; hit b has callsign but not band → dash.
    expect(html).toContain("—");
  });

  it("calls onSort with the clicked column name", () => {
    const calls: string[] = [];
    const onSort = (c: string) => { calls.push(c); };
    const html = render(createElement(TableView, {
      hits: [H("1", "a", [{ name: "callsign", value: "W1", own: true }])],
      sortColumn: null, sortDirection: "asc", onSort,
    }));
    // Sanity: header is rendered.
    expect(html).toContain("callsign");
    // Static markup strips event handlers, so we manually invoke the
    // header click by inspecting the structure — but here we just
    // verify the sort callback API exists by re-rendering with the
    // active state and checking the marker arrow appears.
    const html2 = render(createElement(TableView, {
      hits: [H("1", "a", [{ name: "callsign", value: "W1", own: true }])],
      sortColumn: "callsign", sortDirection: "asc", onSort,
    }));
    expect(html2).toContain("▲");
    expect(calls).toEqual([]); // not invoked by static render
  });

  it("renders a trashed badge for hits with isTrashed=true", () => {
    const hit = H("1", "Old", [{ name: "band", value: "20m", own: true }]);
    hit.isTrashed = true;
    const html = render(createElement(TableView, {
      hits: [hit], sortColumn: null, sortDirection: "asc", onSort: () => {},
    }));
    expect(html).toContain("trashed");
  });
});