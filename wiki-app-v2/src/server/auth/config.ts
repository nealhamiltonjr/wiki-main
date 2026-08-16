import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { getDb } from "../db/index.js";
import * as schema from "../db/auth-schema.js";
import { isFirstUser, seedWelcomeSpace } from "../services/bootstrap.service.js";

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

function resolveAuthSecret(): string {
  const fromEnv = process.env.BETTER_AUTH_SECRET;
  if (fromEnv) return fromEnv;
  const nodeEnv = (process.env.NODE_ENV ?? "development").toLowerCase();
  if (nodeEnv === "production") {
    throw new Error(
      "BETTER_AUTH_SECRET must be set in production. Refusing to boot with " +
        "the publicly-known dev placeholder — anyone reading the source " +
        "could forge session cookies.",
    );
  }
  if (nodeEnv !== "test") {
    console.warn(
      "[auth] BETTER_AUTH_SECRET not set — using dev placeholder. " +
        "Set BETTER_AUTH_SECRET before deploying to production.",
    );
  }
  return defaultSecret;
}

export function createAuth() {
  const { adapter } = getAuthDb();
  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    secret: resolveAuthSecret(),
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
        ? (() => {
            try {
              return {
                customRules: JSON.parse(process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES!) as Record<
                  string,
                  { window: number; max: number } | false
                >,
              };
            } catch {
              console.warn("[auth] BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES is invalid JSON — ignoring");
              return {};
            }
          })()
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
    // Slice-18 — first-boot bootstrap. Without these hooks, a fresh deploy
    // would either (a) have no admins (the brief's PATCH /api/users/:id
    // promotion requires an existing admin, so it's a chicken-and-egg), or
    // (b) require a CLI workaround to seed the first admin and the Welcome
    // space. Both hooks run inside better-auth's adapter transaction so
    // there's no race between "check users empty" and "insert admin."
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (await isFirstUser()) {
              // Override the adapter-bound user object: this user becomes the
              // first admin. additionalFields.isAdmin has input:false, so the
              // client cannot reach this code path; the only way to set
              // isAdmin=true at sign-up is via this server-side hook.
              return { data: { ...user, isAdmin: true } };
            }
            return { data: user };
          },
          after: async (user) => {
            // Seed the §11.6 Welcome space for the newly-promoted admin.
            // Failures are logged, never thrown: a sign-up response must not
            // be 5xx'd because of a seed hiccup, and the next-boot sweep
            // (manual `npm run seed-welcome`) can repair an empty install.
            // seedWelcomeSpace is race-safe: the count-check + insert pair
            // runs inside a sync transaction (better-sqlite3 serializes
            // concurrent BEGINs on the write lock), so two first sign-ups
            // cannot produce two Welcome spaces — see slice-41.
            try {
              await seedWelcomeSpace(user.id);
            } catch (err) {
              console.warn("[bootstrap] welcome-space seed failed:", { userId: user.id, err: String(err) });
            }
          },
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
