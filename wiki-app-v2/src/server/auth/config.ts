import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { getDb } from "../db/index.js";
import * as schema from "../db/auth-schema.js";

function getAuthDb() {
  const { db } = getDb();
  return { db, adapter: drizzleAdapter(db, { provider: "sqlite", schema }) };
}

/**
 * better-auth wiring, ported from the old app (brief §2 / §3.8) with the two
 * non-negotiables from the brief made explicit rather than inherited:
 *
 *  - `rateLimit` is EXPLICITLY enabled (better-auth's built-in limiter only
 *    turns on in production by default — we do not rely on framework
 *    defaults, §3.2). Tunable via env; sane LAN-scale defaults otherwise.
 *  - `trustedOrigins` is EXPLICIT, including the `192.168.*:*` wildcard —
 *    intentional, this runs in Docker with host-network mapping (§2).
 *
 * `baseURL` is also explicit, not derived from request headers: a real bug in
 * the old app where Vite's dev proxy forwarded headers differently enough that
 * better-auth's origin-derivation logic threw a 500 instead of a 401.
 */
const defaultSecret =
  "dev-only-better-auth-secret-change-me-0123456789abcdef0123456789abcdef";

export function createAuth() {
  const { adapter } = getAuthDb();
  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    secret: process.env.BETTER_AUTH_SECRET ?? defaultSecret,
    trustedOrigins: [
      process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
      ...(process.env.BETTER_EXTRA_TRUSTED_ORIGINS
        ? process.env.BETTER_EXTRA_TRUSTED_ORIGINS.split(",").map((o) => o.trim())
        : []),
      "http://localhost:*",
      "http://127.0.0.1:*",
      "http://0.0.0.0:*",
      "http://192.168.*:*",
    ],
    database: adapter,
    emailAndPassword: {
      enabled: true,
    },
    rateLimit: {
      enabled: true,
      window: Number(process.env.BETTER_AUTH_RATE_LIMIT_WINDOW ?? 60),
      max: Number(process.env.BETTER_AUTH_RATE_LIMIT_MAX ?? 20),
      ...(process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES
        ? {
            customRules: JSON.parse(process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES) as Record<
              string,
              { window: number; max: number } | false
            >,
          }
        : {}),
    },
    socialProviders: {
      ...(process.env.GOOGLE_CLIENT_ID
        ? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET! } }
        : {}),
      ...(process.env.GITHUB_CLIENT_ID
        ? { github: { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET! } }
        : {}),
    },
    user: {
      additionalFields: {
        isAdmin: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
        suspended: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
  });
}

/** Singleton auth instance — constructed lazily via getAuth() because the DB
 *  may not be initialised yet at module-load time (e.g. in tests that call
 *  closeDb() between test files). */
let _auth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  if (!_auth) _auth = createAuth();
  return _auth;
}

/** Reset the singleton — only for test teardown. */
export function resetAuth() {
  _auth = undefined;
}

type _Auth = ReturnType<typeof createAuth>;
export type Session = _Auth extends { $Infer: infer S } ? S : never;
