import { useEffect, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

/**
 * Brief §12.5 — "Pin for offline reading" toggle in the page header. The
 * server records the pin; the client-side service worker (public/sw.js)
 * watches `/api/pinned/<branchId>` responses and caches the page's HTML
 * + `/api/branches/<id>/page` payload for offline reads. When the user
 * un-pins, the service worker purges the cached entry on the next
 * navigation to that page.
 */
export function PinButton({
  branchId,
  initiallyPinned = false,
}: {
  branchId: string;
  initiallyPinned?: boolean;
}) {
  const [pinned, setPinned] = useState(initiallyPinned);
  const [busy, setBusy] = useState(false);

  // Sync with the server's view if the parent's `initiallyPinned` changes
  // (e.g. after the offline list refreshes in the background).
  useEffect(() => setPinned(initiallyPinned), [initiallyPinned]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const next = !pinned;
    setPinned(next); // optimistic
    try {
      const res = await api.togglePinned(branchId);
      setPinned(res.pinned);
      // Tell the service worker about the new pin state so it can warm
      // the cache immediately. We don't await this — a failed message
      // post just means the SW will pick up the new state on the next
      // navigation. Network failure here shouldn't block the toggle.
      try {
        if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: next ? "pin" : "unpin",
            branchId,
          });
        }
      } catch {
        /* SW not yet ready, ignore */
      }
    } catch {
      setPinned(!next); // revert on server error
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-label={pinned ? "Remove from offline reading" : "Pin for offline reading"}
      aria-pressed={pinned}
      title={
        pinned
          ? "Available offline — pinned to this device"
          : "Pin to make this page available when the wiki is unreachable"
      }
      data-testid="pin-button"
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors",
        pinned
          ? "bg-accent/10 text-accent hover:bg-accent/20"
          : "text-text-secondary hover:bg-surface-hover"
      )}
    >
      {pinned ? <Pin className="h-4 w-4 fill-current" /> : <PinOff className="h-4 w-4" />}
    </button>
  );
}