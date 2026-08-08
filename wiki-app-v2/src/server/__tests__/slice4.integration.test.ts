import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice 4 gate: space/tree routes wired to the real permission middleware.
// Env vars MUST be set before the app module is imported.
const TEST_DB_PATH = "data/test-slice4.db";

process.env.DB_PATH = TEST_DB_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
// Multiple sign-ups per test file share better-auth's single in-memory bucket
// (no client IP in .inject()), and sign-up/sign-in paths ship a stricter
// built-in limit (3 req/10s) that ignores `max`. customRules disables them.
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

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
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

async function signUpAndGetCookie(email: string, name: string): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name, email, password: "correct-horse-battery-staple" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: "correct-horse-battery-staple" },
  });
  expect(signIn.statusCode).toBe(200);
  return { cookie: extractSessionCookie(signIn.headers["set-cookie"]), userId: body.user.id };
}

describe("slice 4 gate: space/tree routes behind the permission middleware", () => {
  it("requires authentication for /api/spaces", async () => {
    const res = await app.inject({ method: "GET", url: "/api/spaces" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a space as an authenticated user and lists it", async () => {
    const { cookie } = await signUpAndGetCookie("owner4@example.com", "Owner");

    const create = await app.inject({
      method: "POST",
      url: "/api/spaces",
      headers: { cookie },
      payload: { name: "My Space" },
    });
    expect(create.statusCode).toBe(201);
    const space = create.json();
    expect(space.id).toBeTruthy();

    const list = await app.inject({ method: "GET", url: "/api/spaces", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const spaces = list.json();
    expect(spaces.map((s: { name: string }) => s.name)).toContain("My Space");
  });

  it("returns the seeded tree shape and filters deleted pages", async () => {
    const { cookie, userId } = await signUpAndGetCookie("tree4@example.com", "Tree Owner");

    const create = await app.inject({
      method: "POST",
      url: "/api/spaces",
      headers: { cookie },
      payload: { name: "Tree Space" },
    });
    const spaceId = create.json().id as string;

    // Insert a small tree directly (branch creation routes are slice 6).
    const { getDb } = await import("../db/index.js");
    const { db } = getDb();
    const { pages, branches } = await import("../db/schema.js");

    const pageA = crypto.randomUUID();
    const pageB = crypto.randomUUID();
    const pageC = crypto.randomUUID();
    await db.insert(pages).values([
      { id: pageA, slug: "root", title: "Root", content: { type: "doc", content: [{ type: "paragraph" }] }, ownerId: userId },
      { id: pageB, slug: "child", title: "Child", content: { type: "doc", content: [{ type: "paragraph" }] }, ownerId: userId },
      { id: pageC, slug: "hidden", title: "Hidden", content: { type: "doc", content: [{ type: "paragraph" }] }, ownerId: userId },
    ]);
    const branchA = crypto.randomUUID();
    const branchB = crypto.randomUUID();
    const branchC = crypto.randomUUID();
    await db.insert(branches).values([
      { id: branchA, pageId: pageA, spaceId, createdBy: userId, parentBranchId: null, position: 0 },
      { id: branchB, pageId: pageB, spaceId, createdBy: userId, parentBranchId: branchA, position: 0 },
      { id: branchC, pageId: pageC, spaceId, createdBy: userId, parentBranchId: branchB, position: 0, visibility: "private" },
    ]);

    // Deleted page — must be filtered out of the tree.
    const deletedPage = crypto.randomUUID();
    await db.insert(pages).values({
      id: deletedPage,
      slug: "trash-me",
      title: "Trash",
      content: { type: "doc", content: [{ type: "paragraph" }] },
      ownerId: userId,
      deletedAt: new Date(),
    });
    const deletedBranch = crypto.randomUUID();
    await db.insert(branches).values({
      id: deletedBranch,
      pageId: deletedPage,
      spaceId,
      createdBy: userId,
      parentBranchId: null,
      position: 9,
    });

    const tree = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/tree`,
      headers: { cookie },
    });
    expect(tree.statusCode).toBe(200);
    const body = tree.json() as { slug: string; children: { slug: string; children: { slug: string }[] }[] }[];

    const root = body.find((n) => n.slug === "root");
    expect(root).toBeTruthy();
    expect(root?.children.map((c) => c.slug)).toContain("child");
    // The private grandchild is still visible to its owner (admin in the space).
    expect(root?.children[0]?.children.map((c) => c.slug)).toContain("hidden");
    // Deleted page never appears.
    expect(body.map((n) => n.slug)).not.toContain("trash-me");
  });

  it("denies space access to a non-member", async () => {
    const { cookie } = await signUpAndGetCookie("owner5@example.com", "Owner");

    const create = await app.inject({
      method: "POST",
      url: "/api/spaces",
      headers: { cookie },
      payload: { name: "Private Space" },
    });
    const spaceId = create.json().id as string;

    const stranger = await signUpAndGetCookie("stranger5@example.com", "Stranger");

    const tree = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/tree`,
      headers: { cookie: stranger.cookie },
    });
    expect(tree.statusCode).toBe(403);

    // Owner (space admin) still reads it.
    const ownerTree = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/tree`,
      headers: { cookie },
    });
    expect(ownerTree.statusCode).toBe(200);
  });
});
