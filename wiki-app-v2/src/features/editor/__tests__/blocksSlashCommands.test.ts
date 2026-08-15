import { describe, it, expect, beforeEach } from "vitest";
import type { Editor } from "@tiptap/core";
import {
  registerBlocksSlashCommands,
} from "@/features/editor/extensions/blocksSlashCommands.js";
import { resetRegistryForTests, getSlashCommands } from "@/plugins/registry.js";

type Call = { method: string; args: unknown[] };

// Recording editor — every chain method captures and returns the same
// (proxy-omed) chain reference so chained calls keep working.
function makeRecorder() {
  const calls: Call[] = [];
  const chain: any = {};
  // Build a proxy first, then bind known chainable methods to return proxy.
  const proxy = new Proxy(chain, {
    get(target, prop: string) {
      if (prop in target) return (target as any)[prop];
      // Return a function that records and yields the same proxy.
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return proxy;
      };
    },
  });
  chain.focus = () => proxy;
  chain.run = () => { calls.push({ method: "run", args: [] }); return proxy; };
  return { editor: { chain: () => proxy } as unknown as Editor, calls };
}

describe("registerBlocksSlashCommands (§13.6)", () => {
  beforeEach(() => {
    resetRegistryForTests();
  });

  it("registers the expected first-party block commands", () => {
    registerBlocksSlashCommands();
    const cmds = getSlashCommands();
    const names = cmds.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      "heading-1", "heading-2", "heading-3", "heading-4",
      "bullet-list", "numbered-list", "quote", "code", "divider",
    ]));
  });

  it("each registered command has a runnable run() (recording editor)", () => {
    registerBlocksSlashCommands();
    const cmds = getSlashCommands();
    for (const cmd of cmds) {
      const { editor, calls } = makeRecorder();
      cmd.run(editor);
      // The chain must record at least one method beyond initial construction.
      // StarterKit toggleHeading/toggleBulletList/toggleOrderedList etc. each
      // produce a chain method like toggleHeading — we just assert it ran.
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it("registers idempotently (duplicate call does not throw)", () => {
    registerBlocksSlashCommands();
    expect(() => registerBlocksSlashCommands()).not.toThrow();
    // Second call was swallowed — registry still has exactly the same count.
    const firstCount = getSlashCommands().length;
    registerBlocksSlashCommands();
    expect(getSlashCommands().length).toBe(firstCount);
  });
});
