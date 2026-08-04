import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-attrs.db";
const TEST_REPO_ROOT = "./data/test-attrs-repo";
const TEST_FILES_ROOT = "./data/test-attrs-files";
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "at-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "at-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let app: FastifyInstance;

function extractCookie(h: string | string[] | undefined): string {
  const r = Array.isArray(h) ? h[0] : h;
  return r?.split(";")[0] ?? "";
}

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  for (const p of [TEST_DB_PATH, TEST_REPO_ROOT, TEST_FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });
  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_REPO_ROOT, TEST_FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

async function signupAsAdmin(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/sign-up/email", payload: { email, password: "pw-" + email, name: "Admin" } });
  // First user is auto-admin
  return extractCookie(res.headers["set-cookie"]);
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  return JSON.parse(res.body).id as string;
}

async function createPage(cookie: string, spaceId: string, slug: string) {
  const res = await app.inject({ method: "POST", url: "/api/pages", headers: { cookie }, payload: { slug, spaceId, parentBranchId: null } });
  return JSON.parse(res.body) as { pageId: string; branchId: string };
}

describe("attributes (§7.12d.2)", () => {
  it("CRUD: create, list, update, delete", async () => {
    const c = await signupAsAdmin("attr-test@example.com");
    const spaceId = await createSpace(c, "ATTR");
    const { pageId, branchId } = await createPage(c, spaceId, "test-page");

    // Create
    const r1 = await app.inject({ method: "POST", url: `/api/branches/${branchId}/attributes`, headers: { cookie: c }, payload: { name: "sourceUrl", value: "https://example.com", isPromoted: true } });
    expect(r1.statusCode).toBe(201);
    const a1 = JSON.parse(r1.body);
    expect(a1.name).toBe("sourceUrl");
    expect(a1.isPromoted).toBe(true);

    // List
    const r2 = await app.inject({ method: "GET", url: `/api/branches/${branchId}/attributes`, headers: { cookie: c } });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body).attributes).toHaveLength(1);

    // Update (branchId is required so the server can check editor access)
    const r3 = await app.inject({ method: "PUT", url: `/api/attributes/${a1.id}`, headers: { cookie: c }, payload: { branchId, value: "https://updated.com" } });
    expect(r3.statusCode).toBe(200);
    expect(JSON.parse(r3.body).value).toBe("https://updated.com");

    // Delete (branchId is required as a query param)
    const r4 = await app.inject({ method: "DELETE", url: `/api/attributes/${a1.id}?branchId=${branchId}`, headers: { cookie: c } });
    expect(r4.statusCode).toBe(200);

    // List after delete
    const r5 = await app.inject({ method: "GET", url: `/api/branches/${branchId}/attributes`, headers: { cookie: c } });
    expect(JSON.parse(r5.body).attributes).toHaveLength(0);
  });

  it("update/delete require editor access on the supplied branchId, not just any login", async () => {
    const ownerCookie = await signupAsAdmin("attr-owner@example.com");
    const viewerCookie = await signupAsAdmin("attr-viewer@example.com");
    const spaceId = await createSpace(ownerCookie, "ATTR-PERM");
    const { branchId } = await createPage(ownerCookie, spaceId, "guarded-page");

    const created = await app.inject({
      method: "POST", url: `/api/branches/${branchId}/attributes`,
      headers: { cookie: ownerCookie }, payload: { name: "k", value: "v" },
    });
    const attr = JSON.parse(created.body);

    const { db } = await import("../db/index.js");
    const { users, spaceMembers } = await import("../db/schema.js");
    const { sql } = await import("drizzle-orm");
    const [viewer] = await db.select({ id: users.id }).from(users).where(sql`email = 'attr-viewer@example.com'`);
    await db.insert(spaceMembers).values({ spaceId, userId: viewer!.id, role: "viewer" }).run();

    // A viewer (not editor) on the owning branch must be rejected, not silently allowed.
    const putAsViewer = await app.inject({
      method: "PUT", url: `/api/attributes/${attr.id}`,
      headers: { cookie: viewerCookie }, payload: { branchId, value: "hijacked" },
    });
    expect(putAsViewer.statusCode).toBe(403);

    const deleteAsViewer = await app.inject({
      method: "DELETE", url: `/api/attributes/${attr.id}?branchId=${branchId}`,
      headers: { cookie: viewerCookie },
    });
    expect(deleteAsViewer.statusCode).toBe(403);

    // The attribute must be untouched.
    const stillThere = await app.inject({ method: "GET", url: `/api/branches/${branchId}/attributes`, headers: { cookie: ownerCookie } });
    expect(JSON.parse(stillThere.body).attributes[0].value).toBe("v");
  });

  it("update/delete reject a branchId that has editor access but doesn't own the attribute", async () => {
    const c = await signupAsAdmin("attr-crossbranch@example.com");
    const spaceId = await createSpace(c, "ATTR-CROSS");
    const pageA = await createPage(c, spaceId, "page-a");
    const pageB = await createPage(c, spaceId, "page-b");

    const created = await app.inject({
      method: "POST", url: `/api/branches/${pageA.branchId}/attributes`,
      headers: { cookie: c }, payload: { name: "k", value: "v" },
    });
    const attr = JSON.parse(created.body);

    // The caller has editor access to pageB's branch (they created the whole
    // space), but that branch does not own this attribute - must be rejected.
    const put = await app.inject({
      method: "PUT", url: `/api/attributes/${attr.id}`,
      headers: { cookie: c }, payload: { branchId: pageB.branchId, value: "hijacked" },
    });
    expect(put.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE", url: `/api/attributes/${attr.id}?branchId=${pageB.branchId}`,
      headers: { cookie: c },
    });
    expect(del.statusCode).toBe(403);
  });
});
