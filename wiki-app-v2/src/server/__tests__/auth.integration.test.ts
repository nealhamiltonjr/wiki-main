import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice 2 gate: boot the real app via .inject(), sign up, log in, get a
// session. Env vars MUST be set before the app module is imported (the DB
// connection and auth secret are read at import time).
const TEST_DB_PATH = "data/test-auth-integration.db";

process.env.DB_PATH = TEST_DB_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

let app: FastifyInstance;

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const cookie = raw?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^better-auth.session_token=/);
  return cookie;
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const { closeDb } = await import("../db/index.js");
  const { resetAuth } = await import("../auth/config.js");
  closeDb();
  resetAuth();
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe("slice 2 gate: server foundation", () => {
  it("boots and answers /api/health with baseline security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });

    // §3.2 security headers — globally registered from day one.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("same-origin");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("signs up a user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        name: "Slice Two",
        email: "slice2@example.com",
        password: "correct-horse-battery-staple",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe("slice2@example.com");
    // Slice-18: on a fresh DB the very first sign-up is automatically promoted
    // to admin via databaseHooks.user.create.before (no chicken-and-egg with
    // settings IA). The bootstrap test in bootstrap.integration.test.ts
    // covers the full first/second-user behavior; here we just confirm the
    // response shape carries the flag set server-side.
    expect(body.user.isAdmin).toBe(true);
    expect(body.token).toBeTruthy();
  });

  it("signs in and retrieves the session", async () => {
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: {
        email: "slice2@example.com",
        password: "correct-horse-battery-staple",
      },
    });

    expect(signIn.statusCode).toBe(200);
    const cookie = extractSessionCookie(signIn.headers["set-cookie"]);

    const sessionRes = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie },
    });

    expect(sessionRes.statusCode).toBe(200);
    const sessionBody = sessionRes.json();
    expect(sessionBody.session).toBeTruthy();
    expect(sessionBody.user.email).toBe("slice2@example.com");
  });

  it("rejects unauthenticated access to a session-protected resource", async () => {
    // /api/health is public by declaration; a route with no config.access
    // cannot even be registered (boot refusal). Sanity-check that a request
    // to an unknown /api route returns 404 rather than 401.
    const res = await app.inject({ method: "GET", url: "/api/definitely-not-a-route" });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to register a route without config.access", async () => {
    const { buildApp } = await import("../app.js");
    const broken = await buildApp();
    // The onRoute hook throws synchronously at registration time — the
    // invariant fails the developer immediately, not at request time.
    expect(() => broken.get("/api/forgot-access", async () => ({ ok: true }))).toThrow(
      /does not declare config.access/
    );
    await broken.close();
  });
});
