import { api } from "@/api/client";

/**
 * Hand the offline service worker a fresh pin set for the signed-in user.
 *
 * The SW keeps an in-memory `pinnedBranchIds` set that decides which page
 * fetches can be served cache-first. We have to populate that set from the
 * client because SWs can't read cookies and don't carry our session.
 *
 * This MUST be called from inside the authenticated layout — every caller
 * runs after `useSession` confirms a logged-in user, so the API call below
 * cannot 401. Calling it from app-startup (where the session state is
 * unknown) would fire a `/api/pinned` fetch for unauthenticated visitors
 * and log a noisy "401 Unauthorized" to the console — the very regression
 * slice-38 fixes.
 */
export async function seedOfflinePinCache(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  if (!navigator.serviceWorker.controller) return;
  try {
    const pins = await api.listPinned();
    navigator.serviceWorker.controller.postMessage({
      type: "seed",
      branchIds: pins.map((p) => p.branchId),
    });
  } catch {
    // Best-effort: if the user signs out mid-call, the SW will simply
    // keep its previous pin set until the next sign-in re-seeds it.
  }
}

/**
 * Register the offline service worker (public/sw.js).
 *
 * This is deliberately best-effort: failure to register (browser without
 * SW support, served over plain HTTP from a LAN address, etc.) must never
 * prevent the React app from rendering.
 *
 * The SW's pin cache is seeded separately by `seedOfflinePinCache()` from
 * inside the authenticated layout — see that function for why.
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
    .catch((err) => {
      // Common case: a corporate/LAN deployment over plain HTTP that the
      // browser refuses to enable SW on. Not a real failure; just log.
      // eslint-disable-next-line no-console
      console.warn("[offline] service worker registration failed", err);
    });
}