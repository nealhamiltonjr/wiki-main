import { describe, it, expect } from "vitest";
import { tiptapToMarkdown, markdownToTiptap, frontmatterToMarkdown, stripFrontmatter } from "../markdown.service.js";

describe("frontmatterToMarkdown / stripFrontmatter (UI overhaul A4)", () => {
  it("round-trips a git-commit file: frontmatter + body survives stripFrontmatter", () => {
    const fm = frontmatterToMarkdown({ title: 'My "Page"', slug: "my-page", date: "2026-08-01T00:00:00.000Z" });
    const body = "# Heading\n\nBody text.\n";
    const file = fm + "\n" + body;

    expect(fm).toBe('---\ntitle: "My \\"Page\\""\nslug: "my-page"\ndate: "2026-08-01"\n---');
    expect(stripFrontmatter(file)).toBe(body);
  });

  it("stripFrontmatter returns the input unchanged when there is no frontmatter", () => {
    const body = "# Just a body\n\nNo frontmatter here.\n";
    expect(stripFrontmatter(body)).toBe(body);
  });

  it("stripFrontmatter handles CRLF line endings", () => {
    const file = '---\r\ntitle: "Foo"\r\n---\r\n# Body\r\n';
    expect(stripFrontmatter(file)).toBe("# Body\r\n");
  });
});

describe("tiptapToMarkdown", () => {
  it("converts a realistic document with headings, marks, lists, and code blocks", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Proxmox Setup" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "This covers the " },
            { type: "text", text: "base", marks: [{ type: "bold" }] },
            { type: "text", text: " install and " },
            { type: "text", text: "networking docs", marks: [{ type: "link", attrs: { href: "../network/setup.md" } }] },
            { type: "text", text: "." },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Install ISO" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Configure network bridge" }] }] },
          ],
        },
        { type: "codeBlock", attrs: { language: "bash" }, content: [{ type: "text", text: "pveversion" }] },
      ],
    };

    const md = tiptapToMarkdown(doc as any);
    expect(md).toContain("# Proxmox Setup");
    expect(md).toContain("**base**");
    expect(md).toContain("[networking docs](../network/setup.md)");
    expect(md).toContain("- Install ISO");
    expect(md).toContain("```bash\npveversion\n```");
  });

  it("returns an empty string for an empty document rather than throwing", () => {
    expect(tiptapToMarkdown({ type: "doc", content: [] } as any)).toBe("\n");
  });

  it("degrades unknown node types to their inline text instead of dropping them", () => {
    const doc = {
      type: "doc",
      content: [{ type: "someFutureNodeType", content: [{ type: "text", text: "still readable" }] }],
    };
    expect(tiptapToMarkdown(doc as any)).toContain("still readable");
  });

  it("exports task lists with checkbox markers and highlight marks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Ship phase 2" }] }] },
            { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Verify exports" }] }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Key " },
            { type: "text", text: "insight", marks: [{ type: "highlight" }] },
            { type: "text", text: " captured." },
          ],
        },
      ],
    };

    const md = tiptapToMarkdown(doc as any);
    expect(md).toContain("- [x] Ship phase 2");
    expect(md).toContain("- [ ] Verify exports");
    expect(md).toContain("Key ==insight== captured.");
  });
});

describe("markdownToTiptap", () => {
  it("parses task list markers into taskItem nodes with checked attrs", () => {
    const json = markdownToTiptap("- [x] Done\n- [ ] Todo");
    expect(json.type).toBe("doc");
    const taskList = json.content?.[0];
    expect(taskList?.type).toBe("taskList");
    expect(taskList?.content).toHaveLength(2);
    expect(taskList?.content?.[0]).toMatchObject({ type: "taskItem", attrs: { checked: true } });
    expect(taskList?.content?.[1]).toMatchObject({ type: "taskItem", attrs: { checked: false } });
    expect(taskList?.content?.[0]?.content?.[0]?.content?.[0]).toMatchObject({ type: "text", text: "Done" });
  });

  it("round-trips a task list and highlight back to the same markdown", () => {
    const md = "- [x] Ship phase 2\n- [ ] Verify exports\n\nKey ==insight== captured.";
    expect(tiptapToMarkdown(markdownToTiptap(md))).toBe(md + "\n");
  });

  it("never hangs on unmatched special characters (lone = ! [ * `)", () => {
    const md = "key = value, hello! world, [not a link, a * b, back`tick";
    const para = markdownToTiptap(md).content?.[0];
    const text = (para?.content ?? []).map((n: any) => n.text ?? "").join("");
    expect(text).toContain("key = value");
    expect(text).toContain("hello!");
  });

  it("exports mention nodes as readable @Name text instead of dropping them", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ask " },
            { type: "mention", attrs: { id: "u1", label: "Alice", mentionSuggestionChar: "@" } },
            { type: "text", text: " about the bridge" },
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(doc as any);
    expect(md).toContain("Ask @Alice about the bridge");
  });

  it("exports mermaid diagrams as a fenced ```mermaid block and round-trips them back", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "mermaidDiagram",
          content: [{ type: "text", text: "graph TD\n  A-->B" }],
        },
      ],
    };

    const md = tiptapToMarkdown(doc as any);
    expect(md).toContain("```mermaid\ngraph TD\n  A-->B\n```");

    // And the export restores back into a mermaidDiagram node with the source.
    const parsed = markdownToTiptap(md);
    expect(parsed.content?.[0]?.type).toBe("mermaidDiagram");
    const text = (parsed.content?.[0]?.content ?? []).map((n: any) => n.text ?? "").join("");
    expect(text).toBe("graph TD\n  A-->B");
  });
});
