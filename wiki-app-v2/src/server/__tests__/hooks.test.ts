import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerHook,
  unregisterPluginHooks,
  dispatchHook,
  __resetHookRegistry,
  totalHookSubscriptionCount,
} from "../hooks.js";
import type { HookEvent } from "../hookTypes.js";

describe("server hook registry", () => {
  beforeEach(() => {
    __resetHookRegistry();
  });

  it("returns 0 handlers when no plugin is subscribed", async () => {
    const n = await dispatchHook({
      event: "pageLoad",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    });
    expect(n).toBe(0);
  });

  it("invokes a registered handler with the event", async () => {
    const seen: HookEvent[] = [];
    registerHook("plugin-a", "pageLoad", (e) => {
      seen.push(e);
    });
    const ev: HookEvent = {
      event: "pageLoad",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    };
    const n = await dispatchHook(ev);
    expect(n).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(ev);
  });

  it("invokes every handler regardless of plugin id", async () => {
    const seen: string[] = [];
    registerHook("plugin-a", "pageSave", (e) => {
      seen.push(`a:${e.event}`);
      return undefined;
    });
    registerHook("plugin-b", "pageSave", (e) => {
      seen.push(`b:${e.event}`);
      return undefined;
    });
    const n = await dispatchHook({
      event: "pageSave",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    });
    expect(n).toBe(2);
    expect(seen.sort()).toEqual(["a:pageSave", "b:pageSave"]);
  });

  it("does NOT fire handlers for a different event", async () => {
    const seen: string[] = [];
    registerHook("plugin-a", "pageLoad", () => { seen.push("pageLoad"); });
    registerHook("plugin-a", "pageSave", () => { seen.push("pageSave"); });
    await dispatchHook({
      event: "pageLoad",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    });
    expect(seen).toEqual(["pageLoad"]);
  });

  it("isolates a throwing handler so others still run", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reached: string[] = [];
    registerHook("plugin-a", "pageLoad", () => {
      throw new Error("plugin-a kaboom");
    });
    registerHook("plugin-b", "pageLoad", () => {
      reached.push("b");
    });
    const n = await dispatchHook({
      event: "pageLoad",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    });
    expect(n).toBe(2);
    expect(reached).toEqual(["b"]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("unregister fn from registerHook removes that exact subscription", async () => {
    const seen: string[] = [];
    const unregister = registerHook("plugin-a", "pageLoad", () => { seen.push("a"); });
    registerHook("plugin-b", "pageLoad", () => { seen.push("b"); });
    unregister();
    await dispatchHook({
      event: "pageLoad",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    });
    expect(seen).toEqual(["b"]);
  });

  it("unregister fn is idempotent (calling twice does not throw)", async () => {
    const unregister = registerHook("plugin-a", "pageLoad", () => {});
    unregister();
    expect(() => unregister()).not.toThrow();
  });

  it("unregisterPluginHooks removes every subscription owned by the plugin", async () => {
    const seen: string[] = [];
    registerHook("plugin-a", "pageLoad", () => { seen.push("a-load"); });
    registerHook("plugin-a", "pageSave", () => { seen.push("a-save"); });
    registerHook("plugin-a", "attributeChange", () => { seen.push("a-attr"); });
    registerHook("plugin-b", "pageLoad", () => { seen.push("b-load"); });
    expect(totalHookSubscriptionCount()).toBe(4);
    unregisterPluginHooks("plugin-a");
    expect(totalHookSubscriptionCount()).toBe(1);
    await dispatchHook({
      event: "pageLoad",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    });
    expect(seen).toEqual(["b-load"]);
  });

  it("snapshot slicing lets a handler unregister mid-dispatch without corrupting iteration", async () => {
    let unregister: () => void = () => {};
    const seen: string[] = [];
    registerHook("plugin-a", "pageLoad", () => {
      seen.push("a");
      // Try to remove plugin-b from the same registry we're iterating
      unregister();
    });
    unregister = registerHook("plugin-b", "pageLoad", () => {
      seen.push("b");
    });
    const n = await dispatchHook({
      event: "pageLoad",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    });
    expect(n).toBe(2);
    expect(seen.sort()).toEqual(["a", "b"]);
    // After dispatch, plugin-b was removed mid-flight; plugin-a
    // (which fired first and didn't unregister) stays. That's the
    // snapshot guarantee: iteration is safe, but unregister still
    // removes the entry.
    expect(totalHookSubscriptionCount()).toBe(1);
  });

  it("supports async handlers", async () => {
    const seen: string[] = [];
    registerHook("plugin-a", "pageLoad", async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push("done");
    });
    await dispatchHook({
      event: "pageLoad",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      branchId: "b1",
    });
    expect(seen).toEqual(["done"]);
  });

  it("attributeChange event shape carries name/value/valuePageId", async () => {
    const seen: HookEvent[] = [];
    registerHook("plugin-a", "attributeChange", (e) => {
      seen.push(e);
      return undefined;
    });
    await dispatchHook({
      event: "attributeChange",
      at: "2026-01-01T00:00:00.000Z",
      actorUserId: "u1",
      pageId: "p1",
      action: "set",
      attribute: { name: "status", value: "done", valuePageId: "p-target" },
    });
    expect(seen).toHaveLength(1);
    const first = seen[0]!;
    if (first.event === "attributeChange") {
      expect(first.action).toBe("set");
      expect(first.attribute.name).toBe("status");
      expect(first.attribute.value).toBe("done");
      expect(first.attribute.valuePageId).toBe("p-target");
    } else {
      throw new Error("wrong event type");
    }
  });
});