import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

// §7.12g page-level permissions. The permission ENGINE already existed and was
// tested; what shipped here is the API surface (routes to set/read/remove
// per-branch group grants), the tree's restricted-ancestor pruning, and the
// public-mode leak guard (a restricted branch must not be served to anonymous).
// PUBLIC_MODE is enabled for this whole file so the public routes are live.

const TEST_DB_PATH = "./data/test-page-permissions.db";
const TEST_REPO_ROOT = "./data/test-page-permissions-repo";
const TEST_FILES_ROOT = "./data/test-page-permissions-files";

process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "test-only-key-do-not-use-in-real-deployment";
process.env.PUBLIC_MODE = "true";

let app: FastifyInstance;
let db: typeof import("../db/index.js").db;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return raw?.split(";")[0] ?? "";
}

async function signup(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery-staple", name: "T" },
  });
  return extractCookie(res.headers["set-cookie"]);
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function createPage(cookie: string, spaceId: string, slug: string, parentBranchId: string | null = null) {
  const res = await app.inject({ method: "POST", url: "/api/pages", headers: { cookie }, payload: { slug, spaceId, parentBranchId } });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { pageId: string; branchId: string };
}

let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;
let spaceId: string;
let engGroupId: string;
let hrGroupId: string;

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  for (const p of [TEST_DB_PATH, TEST_REPO_ROOT, TEST_FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();
  db = (await import("../db/index.js")).db;

  adminCookie = await signup("perm-admin@example.com");
  aliceCookie = await signup("perm-alice@example.com");
  bobCookie = await signup("perm-bob@example.com");

  // Promote admin, create groups, put alice in Eng and bob in HR.
  const { users, groups } = await import("../db/schema.js");
  await db.update(users).set({ isAdmin: true }).where(sql`email = 'perm-admin@example.com'`).run();
  const [alice] = await db.select({ id: users.id }).from(users).where(sql`email = 'perm-alice@example.com'`);
  const [bob] = await db.select({ id: users.id }).from(users).where(sql`email = 'perm-bob@example.com'`);

  const eng = await app.inject({ method: "POST", url: "/api/groups", headers: { cookie: adminCookie }, payload: { name: "Eng" } });
  const hr = await app.inject({ method: "POST", url: "/api/groups", headers: { cookie: adminCookie }, payload: { name: "HR" } });
  engGroupId = JSON.parse(eng.body).id;
  hrGroupId = JSON.parse(hr.body).id;
  await app.inject({ method: "POST", url: `/api/groups/${engGroupId}/members`, headers: { cookie: adminCookie }, payload: { userId: alice!.id } });
  await app.inject({ method: "POST", url: `/api/groups/${hrGroupId}/members`, headers: { cookie: adminCookie }, payload: { userId: bob!.id } });

  spaceId = await createSpace(aliceCookie, "Perm Space");

  // Bob gets viewer on the space directly so the tree-pruning test is meaningful.
  const { spaceMembers } = await import("../db/schema.js");
  await db.insert(spaceMembers).values({ spaceId, userId: bob!.id, role: "viewer" }).run();
});

afterAll(async () => {
  await app.close();
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_REPO_ROOT, TEST_FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe("per-branch group permissions (§7.12g)", () => {
  it("rejects permission writes from a non-editor", async () => {
    const { branchId } = await createPage(aliceCookie, spaceId, "non-editor-check");
    const res = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/permissions`,
      headers: { cookie: bobCookie },
      payload: { grants: [{ groupId: hrGroupId, role: "viewer" }] },
    });
    // Bob is only a space viewer - setting a boundary needs editor access.
    expect(res.statusCode).toBe(403);
  });

  it("sets, reads, and removes a group grant", async () => {
    const { branchId } = await createPage(aliceCookie, spaceId, "grant-page");

    const put = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/permissions`,
      headers: { cookie: aliceCookie },
      payload: { grants: [{ groupId: engGroupId, role: "editor" }] },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: `/api/branches/${branchId}/permissions`, headers: { cookie: aliceCookie } });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body);
    expect(body.grants).toEqual([{ groupId: engGroupId, groupName: "Eng", role: "editor" }]);
    expect(body.groups.length).toBeGreaterThanOrEqual(2);

    const del = await app.inject({ method: "DELETE", url: `/api/branches/${branchId}/permissions/${engGroupId}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/branches/${branchId}/permissions`, headers: { cookie: aliceCookie } });
    expect(JSON.parse(after.body).grants).toEqual([]);
  });

  it("a boundary grants the member group and denies a non-member space viewer", async () => {
    const { pageId, branchId } = await createPage(aliceCookie, spaceId, "restricted-page");
    await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/permissions`,
      headers: { cookie: aliceCookie },
      payload: { grants: [{ groupId: engGroupId, role: "editor" }] },
    });

    // Alice (in Eng) gets editor on the page.
    const aliceGet = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie: aliceCookie } });
    expect(aliceGet.statusCode).toBe(200);
    expect(JSON.parse(aliceGet.body).access).toBe("editor");

    // Bob (HR only, space viewer) is hard-denied by the boundary.
    const bobGet = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie: bobCookie } });
    expect(bobGet.statusCode).toBe(403);

    // The page content itself is untouched.
    const page = await db.select().from((await import("../db/schema.js")).pages).where(sql`id = ${pageId}`);
    expect(page.length).toBe(1);
  });

  it("clearing the boundary restores inherited space access", async () => {
    const { branchId } = await createPage(aliceCookie, spaceId, "clear-boundary-page");
    await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/permissions`,
      headers: { cookie: aliceCookie },
      payload: { grants: [{ groupId: engGroupId, role: "viewer" }] },
    });
    const denied = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie: bobCookie } });
    expect(denied.statusCode).toBe(403);

    await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/permissions`,
      headers: { cookie: aliceCookie },
      payload: { grants: [] },
    });
    const allowed = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie: bobCookie } });
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body).access).toBe("viewer");
  });
});

describe("restricted-ancestor tree pruning (§7.12g)", () => {
  it("hides a restricted descendant from a caller the boundary denies", async () => {
    const parent = await createPage(aliceCookie, spaceId, "parent-page");
    const child = await createPage(aliceCookie, spaceId, "child-page", parent.branchId);
    const sibling = await createPage(aliceCookie, spaceId, "sibling-page", parent.branchId);

    await app.inject({
      method: "PUT",
      url: `/api/branches/${child.branchId}/permissions`,
      headers: { cookie: aliceCookie },
      payload: { grants: [{ groupId: engGroupId, role: "viewer" }] },
    });

    // Alice sees the full tree.
    const aliceTree = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/tree`, headers: { cookie: aliceCookie } });
    const aliceRoots = JSON.parse(aliceTree.body);
    const aliceParent = aliceRoots.find((r: any) => r.slug === "parent-page");
    expect(aliceParent.children.map((c: any) => c.slug)).toEqual(expect.arrayContaining(["child-page", "sibling-page"]));

    // Bob's tree prunes the restricted child (but keeps the sibling).
    const bobTree = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/tree`, headers: { cookie: bobCookie } });
    const bobRoots = JSON.parse(bobTree.body);
    const bobParent = bobRoots.find((r: any) => r.slug === "parent-page");
    expect(bobParent).toBeDefined();
    const bobChildSlugs = bobParent.children.map((c: any) => c.slug);
    expect(bobChildSlugs).not.toContain("child-page");
    expect(bobChildSlugs).toContain("sibling-page");

    // Direct fetch of the restricted child is also denied (hard boundary, not
    // just a listing nicety).
    const direct = await app.inject({ method: "GET", url: `/api/branches/${child.branchId}/page`, headers: { cookie: bobCookie } });
    expect(direct.statusCode).toBe(403);
  });
});

describe("public-mode restricted leak guard (§7.12g)", () => {
  it("does not serve a public branch that carries a group boundary to anonymous", async () => {
    const { branchId } = await createPage(aliceCookie, spaceId, "public-but-restricted");
    const { branches, pages } = await import("../db/schema.js");
    await db.update(branches).set({ visibility: "public" }).where(sql`id = ${branchId}`).run();
    await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/permissions`,
      headers: { cookie: aliceCookie },
      payload: { grants: [{ groupId: engGroupId, role: "viewer" }] },
    });

    const res = await app.inject({ method: "GET", url: `/api/public/pages/${branchId}` });
    expect(res.statusCode).toBe(404); // anonymous denied by the boundary

    // And it doesn't appear in the public space listing either.
    const list = await app.inject({ method: "GET", url: `/api/public/spaces/${spaceId}/pages` });
    const slugs = JSON.parse(list.body).map((r: any) => r.slug);
    expect(slugs).not.toContain("public-but-restricted");
  });

  it("still serves a genuinely public branch with no boundary to anonymous", async () => {
    const { pageId, branchId } = await createPage(aliceCookie, spaceId, "open-page");
    const { branches, pages } = await import("../db/schema.js");
    await db.update(branches).set({ visibility: "public" }).where(sql`id = ${branchId}`).run();

    const res = await app.inject({ method: "GET", url: `/api/public/pages/${branchId}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).slug).toBe("open-page");
  });
});
