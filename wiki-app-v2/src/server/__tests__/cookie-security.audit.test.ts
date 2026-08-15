import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-cookie-security-${randomBytes(4).toString("hex")}.db`;
const TEST_SECRET = "test-only-secret-do-not-use-in-real-deployment-cccccccccccccccc";
process.env.DB_PATH = DB_PATH;
process.env.BETTER_AUTH_SECRET = TEST_SECRET;
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    rmSync(p, { force: true });
  }
});

/** Pull the set-cookie header value for the session cookie from a multi-value
 *  set-cookie header (Fastify exposes it as `string | string[] | undefined`). */
function getSessionCookie(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(raw).toBeTruthy();
  const cookie = (raw ?? "").split(";")[0]!;
  expect(cookie).toMatch(/^better-auth\.session_token=/);
  return cookie;
}

describe("§3.2 cookie-based session hardening", () => {
  it("the session cookie has HttpOnly + SameSite=Lax|Strict + Path=/ so JS + cross-site POSTs can't ride it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: `ck-a-${randomBytes(4).toString("hex")}@example.com`, password: "correct horse battery staple", name: "CS" },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.headers["set-cookie"];
    const setCookieHeader = Array.isArray(raw) ? raw.join(", ") : (raw ?? "");
    // HttpOnly: the cookie name is exposed but the value cannot be read from JS.
    expect(setCookieHeader.toLowerCase()).toMatch(/;\s*httponly/);
    // SameSite: must be Lax or Strict (NOT None).
    const sameSiteMatch = /;\s*samesite=([^;]+)/i.exec(setCookieHeader);
    expect(sameSiteMatch, `no SameSite attribute on session cookie: ${setCookieHeader}`).toBeTruthy();
    const sameSite = sameSiteMatch![1]!.trim().toLowerCase();
    expect(["lax", "strict"]).toContain(sameSite);
    // Path: the cookie should be scoped to "/" (or a sub-path) so it covers
    // both the auth endpoints and the /api/* routes.
    expect(setCookieHeader.toLowerCase()).toMatch(/;\s*path=\//);
  });

  it("a CSRF cross-origin POST without the cookie still requires the cookie to be present", async () => {
    // Sign up so we have a session.
    const su = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: `ck-b-${randomBytes(4).toString("hex")}@example.com`, password: "correct horse battery staple", name: "CSB" },
    });
    expect(su.statusCode).toBe(200);
    const cookie = getSessionCookie(su.headers["set-cookie"]);

    // better-auth rejects auth mutations from an Origin that isn't in the
    // trustedOrigins allowlist. The /api/auth/sign-out endpoint is the
    // simplest state-changing probe: it requires both the session cookie
    // AND a valid Origin.
    const probe = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: {
        cookie,
        // Attacker-controlled page WOULDN'T be able to set Origin (the browser
        // sends it automatically for cross-origin requests). Simulate the
        // attacker's request by sending an origin NOT in the trusted list.
        origin: "http://attacker.example",
        "content-type": "application/json",
      },
    });
    // better-auth's behaviour varies by version; the important assertion is
    // that the response is NOT a 2xx (the attacker can't sign the user out
    // by tricking them into making a POST).
    expect(probe.statusCode).toBeGreaterThanOrEqual(400);
  });
});
