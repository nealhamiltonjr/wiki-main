import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TableOfContents, extractTocEntries } from "../TableOfContents.js";

const doc = (content: unknown[]) => ({ type: "doc", content });
const heading = (level: number, id: string, text: string) => ({
  type: "heading",
  attrs: { level, id },
  content: [{ type: "text", text }],
});
const para = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("extractTocEntries (pure helper)", () => {
  it("returns an empty list for null / non-doc / empty input", () => {
    expect(extractTocEntries(null)).toEqual([]);
    expect(extractTocEntries(undefined)).toEqual([]);
    expect(extractTocEntries({ type: "paragraph" })).toEqual([]);
    expect(extractTocEntries({ type: "doc" })).toEqual([]);
    expect(extractTocEntries({ type: "doc", content: [] })).toEqual([]);
  });

  it("returns a single entry for a one-heading doc", () => {
    const entries = extractTocEntries(doc([heading(2, "h-1", "Only Heading")]));
    expect(entries).toEqual([{ id: "h-1", level: 2, text: "Only Heading" }]);
  });

  it("preserves document order across multiple top-level headings", () => {
    const entries = extractTocEntries(
      doc([
        heading(1, "h-1", "First"),
        para("some text between"),
        heading(2, "h-2", "Second"),
        heading(3, "h-3", "Third"),
      ])
    );
    expect(entries.map((e) => e.id)).toEqual(["h-1", "h-2", "h-3"]);
    expect(entries.map((e) => e.level)).toEqual([1, 2, 3]);
  });

  it("preserves level when explicit, defaults to 2 when missing", () => {
    const entries = extractTocEntries(
      doc([
        { type: "heading", attrs: { id: "explicit" }, content: [{ type: "text", text: "x" }] },
        { type: "heading", attrs: { level: 4, id: "l4" }, content: [{ type: "text", text: "y" }] },
      ])
    );
    expect(entries[0]!.level).toBe(2);
    expect(entries[1]!.level).toBe(4);
  });

  it("skips headings without an id or with empty text", () => {
    const entries = extractTocEntries(
      doc([
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "no-id" }] },
        { type: "heading", attrs: { level: 2, id: "empty" }, content: [{ type: "text", text: "" }] },
        heading(2, "kept", "Has both"),
      ])
    );
    expect(entries.map((e) => e.id)).toEqual(["kept"]);
  });

  it("only walks top-level nodes — nested headings are out of scope", () => {
    // A heading inside a list item should not appear; the TOC is the
    // page's section outline, not every heading in the prose.
    const entries = extractTocEntries(
      doc([
        heading(2, "section-a", "Section A"),
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [heading(3, "nested", "Nested inside list")],
            },
          ],
        },
        heading(2, "section-b", "Section B"),
      ])
    );
    expect(entries.map((e) => e.id)).toEqual(["section-a", "section-b"]);
  });

  it("concatenates multi-text-run headings (bold/italic/code inside heading)", () => {
    const entries = extractTocEntries(
      doc([
        {
          type: "heading",
          attrs: { level: 2, id: "rich" },
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world", marks: [{ type: "bold" }] },
          ],
        },
      ])
    );
    expect(entries[0]!.text).toBe("Hello world");
  });
});

describe("TableOfContents component", () => {
  it("renders nothing when the doc has fewer than 2 headings", () => {
    const html = renderToStaticMarkup(<TableOfContents content={doc([heading(2, "h-1", "Only")]) } />);
    expect(html).toBe("");
  });

  it("renders nothing for a doc with zero headings", () => {
    const html = renderToStaticMarkup(<TableOfContents content={doc([para("just a paragraph")])} />);
    expect(html).toBe("");
  });

  it("renders a sticky nav with one anchor per heading when ≥ 2 headings exist", () => {
    const html = renderToStaticMarkup(
      <TableOfContents
        content={doc([
          heading(1, "h-1", "First"),
          heading(2, "h-2", "Second"),
        ])}
      />
    );
    expect(html).toContain('aria-label="In-page table of contents"');
    expect(html).toContain('data-testid="page-toc"');
    expect(html).toContain('href="#h-1"');
    expect(html).toContain('href="#h-2"');
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html).toContain("On this page");
  });

  it("indents deeper headings (h3 / h4 / h5) with progressive padding", () => {
    const html = renderToStaticMarkup(
      <TableOfContents
        content={doc([
          heading(1, "a", "Top"),
          heading(3, "b", "Deep 3"),
          heading(4, "c", "Deep 4"),
          heading(5, "d", "Deep 5"),
        ])}
      />
    );
    expect(html).toMatch(/href="#b"[^>]*pl-3/);
    expect(html).toMatch(/href="#c"[^>]*pl-6/);
    expect(html).toMatch(/href="#d"[^>]*pl-9/);
  });

  it("honors a custom minEntries threshold", () => {
    const three = doc([heading(2, "a", "A"), heading(2, "b", "B"), heading(2, "c", "C")]);
    // minEntries=3 should render
    expect(renderToStaticMarkup(<TableOfContents content={three} minEntries={3} />)).toContain('aria-label="In-page table of contents"');
    // minEntries=4 should not
    expect(renderToStaticMarkup(<TableOfContents content={three} minEntries={4} />)).toBe("");
  });

  it("marks the first heading as the active (aria-current=location) by default", () => {
    const html = renderToStaticMarkup(
      <TableOfContents
        content={doc([heading(2, "first", "First"), heading(2, "second", "Second")])}
      />
    );
    // First heading should have aria-current; second should not.
    const firstMatch = html.match(/href="#first"[^>]*aria-current="location"/);
    const secondMatch = html.match(/href="#second"[^>]*aria-current="location"/);
    expect(firstMatch).not.toBeNull();
    expect(secondMatch).toBeNull();
  });
});