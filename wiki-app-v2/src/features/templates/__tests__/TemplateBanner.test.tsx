import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// `@tanstack/react-router`'s <Link> needs a router context that static
// rendering can't supply. Replace it with a plain anchor for these
// pure-presentational assertions.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) =>
    createElement("a", rest as Record<string, unknown>, children),
}));

const { TemplateBanner } = await import("../TemplateBanner");

const render = (ui: React.ReactNode) => renderToStaticMarkup(ui);

describe("TemplateBanner (slice-28, brief §13.3)", () => {
  it("renders nothing when there are no templates", () => {
    const html = render(createElement(TemplateBanner, { templates: [] }));
    expect(html).toBe("");
  });

  it("renders the singular 'Template' header for one template", () => {
    const html = render(
      createElement(TemplateBanner, {
        templates: [{ pageId: "p", title: "QSO Log", branchId: "b", position: 0 }],
      }),
    );
    expect(html).toContain("Template</span>");
    expect(html).not.toContain("Templates</span>");
    expect(html).toContain("QSO Log");
  });

  it("renders the plural 'Templates' header for multiple templates", () => {
    const html = render(
      createElement(TemplateBanner, {
        templates: [
          { pageId: "p1", title: "Alpha", branchId: "b1", position: 0 },
          { pageId: "p2", title: "Beta", branchId: "b2", position: 1 },
        ],
      }),
    );
    expect(html).toContain("Templates</span>");
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
  });

  it("shows the inherited-attribute count (singular for 1)", () => {
    const html = render(
      createElement(TemplateBanner, {
        templates: [{ pageId: "p", title: "T", branchId: "b", position: 0 }],
        inheritedAttributes: [
          {
            id: "x", pageId: "t", name: "a", value: "v", valuePageId: null,
            isPromoted: true, position: 0, templatePageId: "p", templateTitle: "T", depth: 1,
          },
        ],
      }),
    );
    expect(html).toContain("Inherits 1 attribute<");
  });

  it("pluralizes 'attributes' for >1", () => {
    const html = render(
      createElement(TemplateBanner, {
        templates: [{ pageId: "p", title: "T", branchId: "b", position: 0 }],
        inheritedAttributes: [
          {
            id: "1", pageId: "t", name: "a", value: "v", valuePageId: null,
            isPromoted: true, position: 0, templatePageId: "p", templateTitle: "T", depth: 1,
          },
          {
            id: "2", pageId: "t", name: "b", value: "v", valuePageId: null,
            isPromoted: true, position: 1, templatePageId: "p", templateTitle: "T", depth: 1,
          },
        ],
      }),
    );
    expect(html).toContain("Inherits 2 attributes");
  });

  it("does not show the inherited count when inheritedAttributes is empty/missing", () => {
    const html = render(
      createElement(TemplateBanner, {
        templates: [{ pageId: "p", title: "T", branchId: "b", position: 0 }],
      }),
    );
    expect(html).not.toContain("Inherits");
  });
});