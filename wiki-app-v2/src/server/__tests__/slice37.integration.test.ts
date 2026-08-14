import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-37 gate (brief §12.5) — Offline readability for pinned pages.
// Verifies the /api/pinned endpoints behave like /api/favorites (same
// row-level shape: toggle + list + per-user + permission gate) since
// the brief explicitly models pinned pages on top of the favorites
// pattern (read-only caching is the SW's job, not the server's).
//
// Env vars MUST be set before the app module is imported.
const DB_PATH = `data/test-slice37-${randomBytes(4).toString("hex")}.db`;

process.env.DB_PATH = DB_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const cookie = raw?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^better-auth.session_token=/);
  return cookie;
}

async function signup(email: string): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: "U", email, password: "correct-horse-battery-staple" },
  });
  expect(res.statusCode).toBe(200);
  const userId = res.json().user?.id ?? "";
  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: "correct-horse-battery-staple" },
  });
  expect(signIn.statusCode).toBe(200);
  return { cookie: extractCookie(signIn.headers["set-cookie"]), userId };
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createPage(cookie: string, spaceId: string, slug: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  const { closeDb } = await import("../db/index.js");
  const { resetAuth } = await import("../auth/config.js");
  closeDb();
  resetAuth();

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
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe("pinned pages (§12.5)", () => {
  it("toggles pin and lists it with page metadata (incl. pinnedAt)", async () => {
    const { cookie } = await signup(`pin-a-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "PIN");
    const page = await createPage(cookie, spaceId, "offline-doc");

    const on = await app.inject({ method: "POST", url: `/api/pinned/${page.branchId}`, headers: { cookie } });
    expect(on.statusCode).toBe(200);
    expect(on.json().pinned).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/pinned", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const rows = list.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].branchId).toBe(page.branchId);
    expect(rows[0].slug).toBe("offline-doc");
    expect(typeof rows[0].pinnedAt).toBe("string");

    const off = await app.inject({ method: "POST", url: `/api/pinned/${page.branchId}`, headers: { cookie } });
    expect(off.json().pinned).toBe(false);
    const list2 = await app.inject({ method: "GET", url: "/api/pinned", headers: { cookie } });
    expect(list2.json()).toHaveLength(0);
  });

  it("pins are per-user", async () => {
    const a = await signup(`pin-b-${randomBytes(4).toString("hex")}@example.com`);
    const b = await signup(`pin-b2-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(a.cookie, "PIN2");
    const page = await createPage(a.cookie, spaceId, "p");

    await app.inject({ method: "POST", url: `/api/pinned/${page.branchId}`, headers: { cookie: a.cookie } });
    const bList = await app.inject({ method: "GET", url: "/api/pinned", headers: { cookie: b.cookie } });
    expect(bList.json()).toHaveLength(0);
  });

  it("requires auth on GET", async () => {
    const res = await app.inject({ method: "GET", url: "/api/pinned" });
    expect(res.statusCode).toBe(401);
  });
});