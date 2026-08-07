import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from "../db/auth-schema.js";
import { sessionEnrichmentPlugin } from "./session-enrichment.js";

/**
 * Reconciliation decision (brief §3.8/§3.18, previously flagged and unresolved):
 * rather than maintaining a custom `users` table alongside better-auth's own
 * user/session/account/verification tables, we let better-auth own identity
 * entirely and extend ITS user table with the one field this app actually needs
 * beyond the defaults - `isAdmin`. This avoids two parallel "who is this person"
 * systems that could drift out of sync. Everywhere else in this codebase that
 * referenced a standalone `users` table now references better-auth's `user`
 * table instead (see db/schema.ts - the auth tables are generated separately,
 * see package.json's `auth:generate` script, and re-exported from there).
 */
export const auth = betterAuth({
  // Explicit rather than derived from request headers - found a real bug where
  // omitting this caused a 500 (not a graceful 401) specifically when requests
  // came through Vite's dev proxy, whose forwarded headers differ enough from a
  // direct request that better-auth's origin-derivation logic threw instead of
  // just failing the session lookup.
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  // Additional origins that are allowed to make authenticated requests (e.g.
  // the LAN-facing host IP in a dev deployment, or a Vite dev server). Without
  // these, better-auth's CSRF check rejects sign-in/sign-up from any origin not
  // listed here. Values are comma-separated.
  trustedOrigins: [
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    ...(process.env.BETTER_EXTRA_TRUSTED_ORIGINS
      ? process.env.BETTER_EXTRA_TRUSTED_ORIGINS.split(",").map((o) => o.trim())
      : []),
    // Wildcard patterns accept any localhost / loopback origin so users in
    // Docker port-mapped containers don't hit "Invalid origin" CSRF blocks.
    "http://localhost:*",
    "http://127.0.0.1:*",
    "http://0.0.0.0:*",
    "http://192.168.*:*",
  ],
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    // Populated from system_settings at runtime once the settings UI exists
    // (brief §3.9) - client id/secret are never hardcoded here.
    ...(process.env.GOOGLE_CLIENT_ID
      ? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET! } }
      : {}),
    ...(process.env.GITHUB_CLIENT_ID
      ? { github: { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET! } }
      : {}),
  },
  // Authentik (and any other OIDC-speaking IdP) - brief §3.8's generic OIDC plugin
  // requirement. Configured the same way once a system_settings-backed value exists;
  // left as a documented slot rather than a guess at env var names.
  // genericOAuth: { config: [{ providerId: "authentik", ... }] },

  user: {
    additionalFields: {
      isAdmin: { type: "boolean", required: false, defaultValue: false, input: false }, // input:false - never settable via the public API, only by direct DB/admin action
      suspended: { type: "boolean", required: false, defaultValue: false, input: false },
    },
  },
  plugins: [sessionEnrichmentPlugin],
});

export type Session = typeof auth.$Infer.Session;
