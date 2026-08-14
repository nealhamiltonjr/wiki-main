import { describe, it, expect } from "vitest";
import { tiptapToMarkdown } from "../markdown.service.js";

/**
 * §11.2 — "Keep the raw export complete even as plugins add new content
 * types". A page that contains a plugin-registered node must still export
 * to a useful, recoverable Markdown representation even after the plugin
 * that registered the node has been disabled or uninstalled. Silently
 * dropping the content (the old fallthrough) is a data-loss bug.
 */
describe("§11.2 raw export survives disabled-plugin content", () => {
  it("drawioEmbed round-trips through a fenced ```drawio block (title preserved)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Network diagram:" }],
        },
        {
          type: "drawioEmbed",
          attrs: {
            title: "Homelab VLAN",
            xml: "<mxfile><diagram>hello</diagram></mxfile>",
          },
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Some prose after the diagram." }],
        },
      ],
    } as never;

    const md = tiptapToMarkdown(doc);
    // The diagram must be visible in the export (not silently dropped)
    expect(md).toContain("Homelab VLAN");
    expect(md).toContain("(Draw.io diagram");
    // The XML must round-trip into a fenced block so a future re-install
    // could theoretically restore the node.
    expect(md).toContain("```drawio");
    expect(md).toContain("<mxfile><diagram>hello</diagram></mxfile>");
    // The rest of the document must still be present.
    expect(md).toContain("Network diagram:");
    expect(md).toContain("Some prose after the diagram.");
  });

  it("unknown plugin node degrades to a labeled placeholder, not an empty string", () => {
    // Imagine a future plugin that registers a `weatherWidget` node type
    // and is later uninstalled. The page still contains the node. The
    // raw export must produce a visible, labelled placeholder rather
    // than dropping the content silently.
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Today" }],
        },
        {
          type: "weatherWidget",
          attrs: { city: "Portland", unit: "F" },
        },
      ],
    } as never;

    const md = tiptapToMarkdown(doc);
    // The placeholder line must name the unknown type so a human can see
    // *what* got flattened.
    expect(md).toContain("`weatherWidget`");
    // The attrs must round-trip as a fenced block — that's the
    // recovery artifact the user can mine later.
    expect(md).toContain("```weatherWidget");
    expect(md).toContain('"city": "Portland"');
    expect(md).toContain('"unit": "F"');
    // Rest of doc must still be present (the unknown node did not
    // poison the whole export).
    expect(md).toContain("Today");
  });

  it("an unknown node with non-serializable attrs falls back to a marker rather than throwing", () => {
    // Circular structures can't be JSON.stringified — the export path
    // must not crash the page save. We can't actually pass a real
    // circular structure through the JSON.stringify we control, but
    // we can prove the safe path is reached by handing in a value
    // whose toJSON throws.
    const badAttrs = {
      get toJSON() {
        throw new Error("boom");
      },
    };
    const doc = {
      type: "doc",
      content: [
        { type: "customPlugin", attrs: badAttrs },
      ],
    } as never;

    // Should not throw.
    const md = tiptapToMarkdown(doc);
    expect(md).toContain("`customPlugin`");
    expect(md).toContain("(attrs not serializable)");
  });
});
