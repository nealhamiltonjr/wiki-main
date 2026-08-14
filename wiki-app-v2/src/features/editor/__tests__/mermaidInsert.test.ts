import { describe, it, expect } from "vitest";
import type { Editor } from "@tiptap/core";
import { insertMermaidDiagram, MERMAID_STARTER } from "../extensions/mermaidInsert.js";

/**
 * Tests the slash-command / toolbar insert path for Mermaid (§13.6). The
 * test doubles stand in for a real Tiptap editor — the production function
 * only relies on `editor.chain().focus().insertContent(...).run()`, which is
 * the same shape.
 */

function makeRecorder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain = {
    focus() { return chain; },
    insertContent(arg: unknown) {
      calls.push({ method: "insertContent", args: [arg] });
      return chain;
    },
    run() {
      calls.push({ method: "run", args: [] });
      return true;
    },
  };
  const editor = { chain: () => chain };
  return { editor: editor as unknown as Editor, calls };
}

describe("insertMermaidDiagram", () => {
  it("inserts a mermaidDiagram node followed by a paragraph", () => {
    const { editor, calls } = makeRecorder();
    expect(insertMermaidDiagram(editor)).toBe(true);

    const insertCall = calls.find((c) => c.method === "insertContent");
    expect(insertCall).toBeDefined();
    if (!insertCall) throw new Error("insertContent not called");

    const content = insertCall.args[0] as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    expect(content).toHaveLength(2);

    // First node: a mermaidDiagram block holding the starter text.
    expect(content[0]?.type).toBe("mermaidDiagram");
    const inner = content[0]?.content?.[0];
    expect(inner?.type).toBe("text");
    expect(inner?.text).toBe(MERMAID_STARTER);

    // Second node: empty paragraph so the caret lands on a new line.
    expect(content[1]?.type).toBe("paragraph");
  });

  it("focuses before inserting and runs after", () => {
    const { editor, calls } = makeRecorder();
    insertMermaidDiagram(editor);
    const sequence = calls.map((c) => c.method);
    expect(sequence[sequence.length - 1]).toBe("run");
    expect(sequence.indexOf("focus")).toBeLessThan(sequence.indexOf("insertContent"));
  });

  it("starter template is non-empty and starts with a Mermaid graph directive", () => {
    expect(MERMAID_STARTER.length).toBeGreaterThan(20);
    expect(MERMAID_STARTER.split("\n")[0]).toMatch(/^graph\s+(TD|LR|BT|RL)/);
  });
});