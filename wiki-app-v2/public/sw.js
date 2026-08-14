/* eslint-disable no-restricted-globals */
// Brief §12.5 — "Offline readability for the pages that matter most".
//
// Scope kept small on purpose (per §0's mission): read-only offline cache
// for explicitly pinned pages, NOT full offline editing/sync.
//
// What this SW does:
//   1. For navigation requests (HTML shell) → network-first, fall back to
//      the last cached `/index.html`. Without that fallback, an offline
//      user gets nothing at all.
//   2. For `/api/branches/<id>/page` → if the page is in the pin set
//      (kept in memory + broadcast via postMessage from PinButton),
//      cache-first. Otherwise network-first with no cache write.
//   3. The shell assets (`/assets/*`) are cached opportunistically on
//      first successful fetch and reused offline.
//
// What this SW does NOT do:
//   - Cache non-pinned pages. The user has to opt in by clicking Pin.
//   - Replicate writes. The server stays the source of truth; if you
//     somehow manage to edit offline, the change is dropped (the editor
//     already shows "Offline — will retry" rather than silently
//     committing local edits).
//   - Authenticate. Cached responses are scoped per-origin by the
//     browser; we don't smuggle other users' pages into the cache.

const CACHE_VERSION = "v1";
const SHELL_CACHE = `wiki-shell-${CACHE_VERSION}`;
const PAGE_CACHE = `wiki-pages-${CACHE_VERSION}`;
const SHELL_URLS = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  // Pre-warm the shell cache so the very first offline navigation has
  // something to fall back to even before any successful fetch.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Best-effort — the dev server may 404 for `/` if there's no
      // static index. We tolerate that rather than failing install.
      Promise.all(
        SHELL_URLS.map((url) =>
          fetch(url, { credentials: "same-origin" })
            .then((res) => (res.ok ? cache.put(url, res.clone()) : null))
            .catch(() => null)
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // Garbage-collect old cache versions on upgrade.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== PAGE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// In-memory mirror of which branches the current client has pinned.
// Persisted to IndexedDB would be a bigger lift than §12.5's scope
// justifies; the server is the durable source of truth and the client
// can re-derive this set by hitting /api/pinned on next load.
const pinnedBranches = new Set();

// Test hook so unit tests can drive the SW without a real postMessage.
self.__pinnedBranches = pinnedBranches;

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "pin" && typeof data.branchId === "string") {
    pinnedBranches.add(data.branchId);
  } else if (data.type === "unpin" && typeof data.branchId === "string") {
    pinnedBranches.delete(data.branchId);
    // Eagerly evict the cached page so an offline navigation to this
    // page goes back to the server's "no" answer instead of stale data.
    event.waitUntil(
      caches.open(PAGE_CACHE).then((cache) => cache.delete(`/api/branches/${data.branchId}/page`))
    );
  } else if (data.type === "seed" && Array.isArray(data.branchIds)) {
    // Called by main.tsx on app boot — keep the SW's view of the pin
    // set in sync with what the server says is currently pinned, so a
    // user who pinned a page on another device still has it cached
    // here next time they open one.
    pinnedBranches.clear();
    for (const id of data.branchIds) pinnedBranches.add(id);
  }
});

function isPageDataRequest(url) {
  // Match /api/branches/<id>/page (and any /api/branches/<id>/page?foo)
  return /^\/api\/branches\/[^/]+\/page(\?|$)/.test(url.pathname);
}

function isShellAsset(url) {
  return SHELL_CACHE && (url.pathname.startsWith("/assets/") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css"));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache mutations

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // ignore cross-origin

  // 1. Pinned page payload → cache-first.
  if (isPageDataRequest(url)) {
    const branchId = url.pathname.split("/")[3];
    if (pinnedBranches.has(branchId)) {
      event.respondWith(handlePinnedPage(req));
      return;
    }
    // Not pinned: pass through and let the server enforce the
    // permission check. We deliberately do NOT cache non-pinned
    // responses, otherwise a viewer with a temporary elevation
    // would leak cached content after the elevation is revoked.
    return;
  }

  // 2. Navigation (HTML shell) → network-first, fall back to cache.
  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(req));
    return;
  }

  // 3. Shell assets → cache-on-second-visit, network-first otherwise.
  if (isShellAsset(url)) {
    event.respondWith(handleShellAsset(req));
    return;
  }
});

async function handlePinnedPage(req) {
  const cache = await caches.open(PAGE_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    // Refresh in the background so the next offline visit is fresher
    // than this one would have been.
    refreshInBackground(req, cache);
    return cached;
  }
  // First visit after pin — go to the network and warm the cache.
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Offline and no cache. Return a synthetic 503 so the client UI
    // can render a friendly "no cached copy yet" placeholder rather
    // than crashing on a TypeError.
    return new Response(
      JSON.stringify({ error: "offline-no-cache", message: "Pinned page is not yet cached on this device" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
}

function refreshInBackground(req, cache) {
  fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
  }).catch(() => { /* network gone; keep stale cache */ });
}

async function handleNavigation(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req) || await cache.match("/index.html");
    if (cached) return cached;
    return new Response(
      "<h1>Offline</h1><p>The wiki is unreachable and no shell has been cached yet. Visit any page while online to bootstrap.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

async function handleShellAsset(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw new Error("asset not in cache");
  }
}

// Exposed for unit tests — see src/features/offline/__tests__/sw.test.ts.
self.__isPageDataRequest = isPageDataRequest;
self.__isShellAsset = isShellAsset;
self.__CACHE_VERSION = CACHE_VERSION;
self.__PAGE_CACHE = PAGE_CACHE;
self.__SHELL_CACHE = SHELL_CACHE;