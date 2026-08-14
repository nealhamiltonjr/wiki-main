import { useCallback, useEffect, useState } from "react";
import { Pin, PinOff, WifiOff, RefreshCw } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { api, type PinnedEntry } from "@/api/client";

/**
 * Brief §12.5 — read-only list of pages the user has explicitly pinned
 * for offline reading. Shown at `/pinned`. The list is purely a UX
 * convenience — the actual offline behaviour is owned by public/sw.js,
 * which gets the same data via the `/api/pinned` endpoint and the
 * in-memory `pinnedBranches` set seeded by `registerOfflineServiceWorker`.
 */
export function OfflinePanel() {
  const [pins, setPins] = useState<PinnedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await api.listPinned();
      setPins(list);
    } catch (e: unknown) {
      // If we're offline, the SW will surface the cached page payload,
      // but `/api/pinned` itself is NOT in the pin cache (it's the
      // *control plane*, not the data plane). Show a friendly hint.
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [reload]);

  const unpin = async (branchId: string) => {
    setPins((cur) => (cur ? cur.filter((p) => p.branchId !== branchId) : cur));
    try {
      await api.togglePinned(branchId);
      try {
        if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: "unpin", branchId });
        }
      } catch {
        /* SW not ready */
      }
    } catch {
      void reload();
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Pin className="h-4 w-4 text-accent" />
          <h1 className="text-lg font-medium">Pinned for offline reading</h1>
          {!online && (
            <span
              className="ml-2 flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning"
              title="You're offline — pinned pages below are still readable."
            >
              <WifiOff className="h-3 w-3" />
              Offline
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-50"
          aria-label="Refresh pinned list"
        >
          <RefreshCw className={"h-3.5 w-3.5 " + (busy ? "animate-spin" : "")} />
          Refresh
        </button>
      </div>

      <p className="mb-4 text-sm text-text-muted">
        Pages pinned here are cached on this device and remain readable when the wiki server is
        unreachable. Cached content is read-only — edits still require a live connection.
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          Could not refresh the pinned list: {error}. Showing what was loaded before the network dropped.
        </div>
      )}

      {pins === null ? (
        <div className="text-sm text-text-muted">Loading…</div>
      ) : pins.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
          No pages pinned yet. Open any page and click the pin icon in its header to add it here.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {pins.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
              data-testid="pinned-entry"
            >
              <Link
                to="/w/$branchId"
                params={{ branchId: p.branchId }}
                className="min-w-0 truncate text-sm hover:underline"
              >
                {p.title || p.slug}
              </Link>
              <div className="flex shrink-0 items-center gap-1">
                <span className="text-xs text-text-muted">
                  {new Date(p.pinnedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => void unpin(p.branchId)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-surface-hover"
                  aria-label={`Unpin ${p.title || p.slug}`}
                  title="Unpin"
                >
                  <PinOff className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}