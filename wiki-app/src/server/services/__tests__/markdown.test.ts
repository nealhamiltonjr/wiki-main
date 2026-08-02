import { describe, it, expect } from "vitest";
import { tiptapToMarkdown, markdownToTiptap } from "../markdown.service.js";

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
});
