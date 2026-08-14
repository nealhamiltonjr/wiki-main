import { api } from "@/api/client";

/**
 * Register the offline service worker (public/sw.js) and seed its in-memory
 * pin set with whatever the server currently reports as pinned for the
 * signed-in user.
 *
 * This is deliberately best-effort: failure to register (browser doesn't
 * support SW, served over an insecure origin that browsers refuse to
 * enable SW on, etc.) must never prevent the React app from rendering.
 * We log a warning and move on.
 */
export function registerOfflineServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  // Service workers require HTTPS or localhost. Skip silently on http://
  // LAN origins — the browser will refuse the register() call anyway, but
  // we don't want to spam the console for every user who can't use the
  // feature.
  const isSecure =
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";
  if (!isSecure) return;

  // Don't fire-and-forget without handling the promise — an unhandled
  // rejection on register() would surface as a noisy console error on
  // every page load.
  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(async (reg) => {
      // Hand the SW our current pin set once it's controlling a client
      // so its in-memory set matches reality (it was empty before).
      // PostMessage silently no-ops if there's no active client yet —
      // the SW also re-fetches via fetch interception, so a missed seed
      // just means the first offline visit hits the network once.
      if (!navigator.serviceWorker.controller) {
        // The SW is installed but not yet controlling this page; give it
        // a moment. If the page was hard-loaded with the SW already in
        // control (common on second visit), this is a no-op.
        await new Promise<void>((resolve) => {
          const onChange = () => {
            navigator.serviceWorker.removeEventListener("controllerchange", onChange);
            resolve();
          };
          navigator.serviceWorker.addEventListener("controllerchange", onChange);
          // Don't wait forever — bail out after 2s.
          setTimeout(resolve, 2000);
        });
      }
      try {
        const pins = await api.listPinned();
        reg.active?.postMessage({
          type: "seed",
          branchIds: pins.map((p) => p.branchId),
        });
      } catch {
        // The user isn't signed in yet (or the call failed); the SW
        // will pick up pins lazily as the user toggles them. Not a
        // failure mode worth surfacing.
      }
    })
    .catch((err) => {
      // Common case: a corporate/LAN deployment over plain HTTP that the
      // browser refuses to enable SW on. Not a real failure; just log.
      // eslint-disable-next-line no-console
      console.warn("[offline] service worker registration failed", err);
    });
}