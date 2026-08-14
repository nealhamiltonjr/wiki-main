import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Brief §12.5 — Service worker is a plain JS file that uses browser
 * globals (self, caches, fetch, clients). To test it without a real
 * browser we:
 *   1. Read public/sw.js as text.
 *   2. Eval it inside a sandbox with a minimal `self` polyfill.
 *   3. Assert that the URL routing helpers (`isPageDataRequest`,
 *      `isShellAsset`) classify URLs the way the brief requires.
 *
 * This is intentionally small: full integration coverage of the fetch
 * event handler belongs in Playwright (slice-37 e2e). What we can lock
 * down here is the deterministic URL classification, since that's the
 * bit most likely to silently regress.
 */

interface FakeSelf {
  addEventListener: (type: string, cb: (event: any) => void) => void;
  skipWaiting: () => Promise<void>;
  clients: { claim: () => Promise<void> };
  location: { origin: string };
  __isPageDataRequest?: (url: URL) => boolean;
  __isShellAsset?: (url: URL) => boolean;
  __pinnedBranches?: Set<string>;
  __CACHE_VERSION?: string;
  __PAGE_CACHE?: string;
  __SHELL_CACHE?: string;
}

interface FakeCaches {
  _data: Map<string, Map<string, Response>>;
  keys: () => Promise<string[]>;
  open: (name: string) => {
    put: (req: any, res: Response) => Promise<void>;
    match: (req: any) => Promise<Response | undefined>;
    delete: (req: any) => Promise<boolean>;
  };
}

function loadSW(): FakeSelf {
  const src = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  const fakeSelf: FakeSelf = {
    addEventListener: () => undefined,
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    location: { origin: "http://localhost" },
  };
  const fakeCaches: FakeCaches = {
    _data: new Map(),
    keys: async function () {
      return Array.from(this._data.keys());
    },
    open: (_name: string) => {
      const name = _name;
      return {
        put: async (req: any, res: Response) => {
          let m = fakeCaches._data.get(name);
          if (!m) { m = new Map(); fakeCaches._data.set(name, m); }
          const key = typeof req === "string" ? req : (req.url || JSON.stringify(req));
          m.set(key, res);
        },
        match: async (req: any) => {
          const m = fakeCaches._data.get(name);
          if (!m) return undefined;
          const key = typeof req === "string" ? req : (req.url || JSON.stringify(req));
          return m.get(key);
        },
        delete: async (req: any) => {
          const m = fakeCaches._data.get(name);
          if (!m) return false;
          const key = typeof req === "string" ? req : (req.url || JSON.stringify(req));
          return m.delete(key);
        },
      };
    },
  };
  const fakeFetch = () => Promise.reject(new Error("network disabled in test"));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function("self", "caches", "fetch", src);
  fn(fakeSelf, fakeCaches, fakeFetch);
  return fakeSelf;
}

describe("service worker — URL classification (§12.5)", () => {
  let sw: FakeSelf;

  beforeEach(() => {
    sw = loadSW();
  });

  it("matches /api/branches/<id>/page (with or without query)", () => {
    expect(sw.__isPageDataRequest!(new URL("http://localhost/api/branches/abc/page"))).toBe(true);
    expect(sw.__isPageDataRequest!(new URL("http://localhost/api/branches/abc/page?foo=1"))).toBe(true);
    expect(sw.__isPageDataRequest!(new URL("http://localhost/api/branches/abc/comments"))).toBe(false);
    expect(sw.__isPageDataRequest!(new URL("http://localhost/api/branches/"))).toBe(false);
    // A page data request must NEVER also be classified as a shell
    // asset — that ambiguity would let the SW pick the wrong cache.
    expect(sw.__isShellAsset!(new URL("http://localhost/api/branches/abc/page"))).toBe(false);
  });

  it("classifies /assets/* and hashed bundle URLs as shell assets", () => {
    expect(sw.__isShellAsset!(new URL("http://localhost/assets/index-abc123.js"))).toBe(true);
    expect(sw.__isShellAsset!(new URL("http://localhost/styles.css"))).toBe(true);
    expect(sw.__isShellAsset!(new URL("http://localhost/foo.png"))).toBe(false);
  });

  it("uses distinct cache names so page writes don't blow away the shell", () => {
    expect(sw.__PAGE_CACHE).not.toBe(sw.__SHELL_CACHE);
    // Bumping CACHE_VERSION is the migration signal — must be present
    // and non-empty so future deploys can invalidate stale caches.
    expect(sw.__CACHE_VERSION).toBeTruthy();
  });

  it("exposes a writable pin set so the client can seed and toggle", () => {
    const set = sw.__pinnedBranches!;
    expect(set.has("branch-1")).toBe(false);
    set.add("branch-1");
    expect(set.has("branch-1")).toBe(true);
    set.delete("branch-1");
    expect(set.has("branch-1")).toBe(false);
  });
});