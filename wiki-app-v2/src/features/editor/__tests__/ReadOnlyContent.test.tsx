import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadOnlyContent } from "../ReadOnlyContent.js";

const doc = (content: unknown[]) => ({ type: "doc", content });

describe("ReadOnlyContent (read-mode renderer)", () => {
  it("renders text marks into semantic HTML", () => {
    const html = renderToStaticMarkup(
      <ReadOnlyContent
        content={doc([
          {
            type: "heading",
            attrs: { level: 2, id: "h-1" },
            content: [{ type: "text", text: "Heading" }],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "bold " },
              { type: "text", text: "bit", marks: [{ type: "bold" }] },
            ],
          },
        ])}
      />
    );
    expect(html).toContain('<h2 id="h-1">Heading</h2>');
    expect(html).toContain("<strong>bit</strong>");
  });

  it("renders mention nodes as readable @Name text (regression: they were invisible)", () => {
    const html = renderToStaticMarkup(
      <ReadOnlyContent
        content={doc([
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Ask " },
              { type: "mention", attrs: { id: "u1", label: "Alice", mentionSuggestionChar: "@" } },
              { type: "text", text: " about it" },
            ],
          },
        ])}
      />
    );
    expect(html).toContain('Ask <span class="mention">@Alice</span> about it');
  });

  it("neutralizes a script-capable link scheme on render (defense in depth)", () => {
    const html = renderToStaticMarkup(
      <ReadOnlyContent
        content={doc([
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "evil",
                marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
              },
            ],
          },
        ])}
      />
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  it("renders a mermaid node without throwing (initial skeleton in SSR)", () => {
    const html = renderToStaticMarkup(
      <ReadOnlyContent
        content={doc([
          { type: "mermaidDiagram", content: [{ type: "text", text: "graph TD\n  A-->B" }] },
        ])}
      />
    );
    // SSR renders the pre-hydration skeleton (the diagram itself renders
    // client-side in a useEffect); the key thing is it doesn't throw.
    expect(html).toContain("animate-pulse");
  });

  it("returns empty for a non-doc payload instead of throwing", () => {
    expect(renderToStaticMarkup(<ReadOnlyContent content={null} />)).toBe("");
    expect(renderToStaticMarkup(<ReadOnlyContent content={{ type: "paragraph" }} />)).toBe("");
  });
});
