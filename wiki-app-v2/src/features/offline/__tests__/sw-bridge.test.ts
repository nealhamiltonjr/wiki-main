import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Brief §12.5 — `seedOfflinePinCache` is only ever called from inside the
 * authenticated layout, AFTER `useSession` resolves. The test suite exists
 * to lock down the property that matters for the user experience: this
 * function must NEVER fire a `/api/pinned` fetch unless there's a SW
 * controller ready to receive the postMessage — otherwise the unauth
 * visitor's console would get a 401 noise on every page load (the
 * regression slice-38 fixes).
 *
 * The function also must not throw on environment-mismatch (no SW API,
 * no controller, fetch failure) — it is best-effort by design.
 */

describe("seedOfflinePinCache", () => {
  type BridgeModule = typeof import("../sw-bridge.js");

  async function loadBridge(): Promise<BridgeModule> {
    return import("../sw-bridge.js");
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns early when navigator.serviceWorker is absent", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
    });
    const { seedOfflinePinCache } = await loadBridge();
    await expect(seedOfflinePinCache()).resolves.toBeUndefined();
  });

  it("returns early when there is no active service worker controller", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { serviceWorker: { controller: null } },
      configurable: true,
    });
    const { seedOfflinePinCache } = await loadBridge();
    await expect(seedOfflinePinCache()).resolves.toBeUndefined();
  });

  it("posts the pin branch IDs to the SW when the controller is present", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(globalThis, "navigator", {
      value: {
        serviceWorker: {
          controller: { postMessage },
        },
      },
      configurable: true,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { branchId: "b1", pageTitle: "Welcome", spaceName: "Home" },
        { branchId: "b2", pageTitle: "Roadmap", spaceName: "Home" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const { seedOfflinePinCache } = await loadBridge();
    await seedOfflinePinCache();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/pinned");
    expect(postMessage).toHaveBeenCalledWith({
      type: "seed",
      branchIds: ["b1", "b2"],
    });
  });

  it("swallows fetch failures without throwing", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(globalThis, "navigator", {
      value: { serviceWorker: { controller: { postMessage } } },
      configurable: true,
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { seedOfflinePinCache } = await loadBridge();
    await expect(seedOfflinePinCache()).resolves.toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });
});