import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "../server/auth/config.js";

/**
 * Found as a real bug deploying to a LAN IP: better-auth's client requires a
 * full absolute URL (it constructs a real URL object with it), and a relative
 * path like "/api/auth" throws "Invalid base URL" the moment the browser tries
 * to use it - it only ever worked in local dev by coincidence. Deriving it
 * from window.location.origin means this works correctly regardless of what
 * IP or hostname the app is actually reached at, with nothing hardcoded.
 */
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [inferAdditionalFields<typeof auth>()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
