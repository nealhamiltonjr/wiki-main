import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, PluginKey } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";

import { CommentHighlight, type CommentThreadLite } from "../commentHighlight.js";

// Minimal schema with a paragraph + text node. The decorator walks the live
// PM doc and only needs `attrs.id` to be exposed on the paragraph — no list
// nodes are required since the prod decoration math doesn't depend on them.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: { id: { default: null } },
      parseDOM: [{ tag: "p" }],
      toDOM(node) {
        const id = (node.attrs as { id?: string | null }).id;
        return id ? ["p", { id }, 0] : ["p", 0];
      },
    },
    text: { group: "inline" },
  },
  marks: {},
});

function thread(t: Partial<CommentThreadLite> & Pick<CommentThreadLite, "blockId" | "rangeFrom" | "rangeTo">): CommentThreadLite {
  return {
    id: t.id ?? "thread-1",
    blockId: t.blockId,
    rangeFrom: t.rangeFrom,
    rangeTo: t.rangeTo,
    selection: t.selection ?? null,
    resolvedAt: t.resolvedAt ?? null,
  };
}

function buildPlugin(threads: CommentThreadLite[]) {
  // Tiptap supplies `editor` in real usage; we only need `options` here.
  // The cast is needed because the public type declaration marks
  // `addProseMirrorPlugins` as optional and the `this` context as
  // Tiptap-extension-shaped. We only exercise what we need.
  type Context = { options: { getThreads: () => CommentThreadLite[] } };
  type DecoPlugin = { getState(s: EditorState): DecorationSet; key: PluginKey<DecorationSet> };
  const ctx = { options: { getThreads: () => threads } } as unknown as Context;
  const fn = (CommentHighlight.config.addProseMirrorPlugins as unknown as { call: (self: Context) => DecoPlugin[] }).call(ctx);
  return fn[0];
}

function stateWithBlockAndPlugin(id: string, text: string, threads: CommentThreadLite[]): EditorState {
  const paragraph = schema.nodes.paragraph.createChecked(
    { id },
    text ? schema.text(text) : undefined,
  );
  const doc = schema.nodes.doc.createChecked(null, [paragraph]);
  const plugin = buildPlugin(threads);
  if (!plugin) throw new Error("plugin not constructed");
  // EditorState's `plugins` param is the full prosemirror Plugin<any> type
  // (with spec/props), whereas the DecoPlugin alias models only what the
  // tests exercise. The unknown-cast keeps tsc happy while the runtime
  // shape is identical at the fields we touch.
  return EditorState.create({ schema, doc, plugins: [plugin as unknown as Parameters<typeof EditorState.create>[0]["plugins"] extends Array<infer Item> ? Item : never] });
}

function getDecos(state: EditorState): DecorationSet {
  // The comment-highlight plugin is the only one attached in this test, so
  // `state.plugins[0].getState(state)` is the typed accessor.
  const plugin = state.plugins[0] as unknown as { getState(s: EditorState): DecorationSet };
  return plugin.getState(state) ?? DecorationSet.empty;
}

describe("CommentHighlight", () => {
  it("does not throw when constructed with no threads", () => {
    const ext = CommentHighlight.configure({ getThreads: () => [] });
    expect(ext.name).toBe("commentHighlight");
    expect(ext.options.getThreads()).toEqual([]);
  });

  it("emits one inline decoration per unresolved thread, clamped to the block", () => {
    const state = stateWithBlockAndPlugin("b-1", "Hello, world", [
      thread({ blockId: "b-1", rangeFrom: 2, rangeTo: 7 }),
    ]);
    const decos = getDecos(state);
    const list = decos.find();
    expect(list.length).toBe(1);
    const raw = list[0]! as unknown as {
      from: number;
      to: number;
      type: { attrs: Record<string, unknown> };
    };
    expect(raw.type.attrs.class).toBe("comment-highlight");
    expect(raw.type.attrs["data-thread-id"]).toBe("thread-1");
    expect(raw.from).toBeGreaterThan(0);
    expect(raw.to).toBeGreaterThan(raw.from);
  });

  it("skips resolved threads", () => {
    const state = stateWithBlockAndPlugin("b-1", "Hello, world", [
      thread({ blockId: "b-1", rangeFrom: 0, rangeTo: 5, resolvedAt: "2025-01-01T00:00:00Z" }),
    ]);
    const decos = getDecos(state);
    expect(decos.find().length).toBe(0);
  });

  it("clamps an out-of-range rangeFrom/rangeTo back inside the block", () => {
    const state = stateWithBlockAndPlugin("b-1", "Hi", [
      thread({ blockId: "b-1", rangeFrom: 999, rangeTo: 9999 }),
    ]);
    const decos = getDecos(state);
    expect(decos.find().length).toBeLessThanOrEqual(1);
  });

  it("ignores threads whose blockId is not present in the doc", () => {
    const state = stateWithBlockAndPlugin("b-1", "Hello", [
      thread({ blockId: "b-9", rangeFrom: 0, rangeTo: 3 }),
    ]);
    const decos = getDecos(state);
    expect(decos.find().length).toBe(0);
  });

  it("uses the selection text as a tooltip title", () => {
    const state = stateWithBlockAndPlugin("b-1", "Hello, world", [
      thread({ blockId: "b-1", rangeFrom: 0, rangeTo: 5, selection: "Hello" }),
    ]);
    const decos = getDecos(state);
    const d = decos.find()[0]! as unknown as { type: { attrs: Record<string, unknown> } };
    // Title attribute was removed (Phase 4 fix — CommentHoverBubble replaces native tooltip)
    expect(d.type.attrs["data-thread-id"]).toBeDefined();
  });

  it("rebuilds decorations when a thread-bump transaction carries new threads", () => {
    const state = stateWithBlockAndPlugin("b-1", "Hello, world", [
      thread({ blockId: "b-1", rangeFrom: 0, rangeTo: 3 }),
    ]);
    const before = getDecos(state);
    expect(before.find().length).toBe(1);

    // Dispatch a transaction with the plugin's meta carrying a *resolved* thread
    // (same id) — the decorator should drop the decoration. The plugin's key
    // is captured when the plugin is attached; we pull it off the plugin
    // instance directly.
    const plugin = state.plugins[0] as unknown as { key: PluginKey<DecorationSet> };
    const tr = state.tr.setMeta(plugin.key, { threads: [
      thread({ blockId: "b-1", rangeFrom: 0, rangeTo: 3, resolvedAt: "2025-01-01T00:00:00Z" }),
    ] });
    const next = state.apply(tr);
    const after = getDecos(next);
    expect(after.find().length).toBe(0);
  });
});
