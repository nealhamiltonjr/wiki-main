import { describe, it, expect } from "vitest";
import type { Editor } from "@tiptap/core";
import { registerCoreCommands } from "../coreCommands.js";
import { getSlashCommands } from "../registry.js";
import { insertMermaidDiagram } from "@/features/editor/extensions/mermaidInsert.js";

/**
 * Tests that the core-command registration path lands every first-party
 * slash command in the registry (§13.6). Uses a recording editor so we don't
 * need a real Tiptap DOM.
 */
function makeRecorder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain = {
    focus() { return chain; },
    insertContent(arg: unknown) {
      calls.push({ method: "insertContent", args: [arg] });
      return chain;
    },
    run() { calls.push({ method: "run", args: [] }); return true; },
  };
  return { editor: { chain: () => chain } as unknown as Editor, calls };
}

describe("registerCoreCommands (§13.6)", () => {
  it("registers a 'mermaid' slash command with the expected metadata", () => {
    registerCoreCommands();
    const cmds = getSlashCommands();
    const mermaid = cmds.find((c) => c.name === "mermaid");
    expect(mermaid).toBeDefined();
    if (!mermaid) throw new Error("mermaid command not registered");
    expect(mermaid.label).toBe("Mermaid diagram");
    expect(mermaid.keywords).toEqual(expect.arrayContaining(["diagram", "chart", "flow", "graph"]));
    expect(mermaid.icon).toBe("◇");
    expect(typeof mermaid.run).toBe("function");
  });

  it("the registered run() actually inserts a mermaidDiagram", () => {
    registerCoreCommands();
    const mermaid = getSlashCommands().find((c) => c.name === "mermaid");
    expect(mermaid).toBeDefined();
    if (!mermaid) throw new Error("mermaid command not registered");
    const { editor, calls } = makeRecorder();
    mermaid.run(editor);
    const insertCall = calls.find((c) => c.method === "insertContent");
    expect(insertCall).toBeDefined();
    if (!insertCall) throw new Error("insertContent not called");
    const content = insertCall.args[0] as Array<{ type: string }>;
    expect(content[0]?.type).toBe("mermaidDiagram");
    expect(content[1]?.type).toBe("paragraph");
  });

  it("the slash command and the toolbar button call the same insert helper", () => {
    registerCoreCommands();
    const mermaid = getSlashCommands().find((c) => c.name === "mermaid");
    expect(mermaid).toBeDefined();
    if (!mermaid) throw new Error("mermaid command not registered");
    const { editor: e1, calls: c1 } = makeRecorder();
    const { editor: e2, calls: c2 } = makeRecorder();
    mermaid.run(e1);
    insertMermaidDiagram(e2);
    expect(c1).toEqual(c2);
  });
});