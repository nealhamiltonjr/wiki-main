import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-security.db";
const TEST_REPO_ROOT = "./data/test-security-repo";
const TEST_FILES_ROOT = "./data/test-security-files";

process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "test-only-key-do-not-use-in-real-deployment";

let app: FastifyInstance;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return raw?.split(";")[0] ?? "";
}

async function signup(email: string): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery-staple", name: "T" },
  });
  return { cookie: extractCookie(res.headers["set-cookie"]), userId: JSON.parse(res.body).user?.id ?? "" };
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function createPage(cookie: string, spaceId: string, slug: string) {
  const res = await app.inject({ method: "POST", url: "/api/pages", headers: { cookie }, payload: { slug, spaceId, parentBranchId: null } });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { pageId: string; branchId: string };
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

async function createApiToken(cookie: string, body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie }, payload: body });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { id: string; token: string };
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

describe("pageId/branchId decoupling", () => {
  it("save through a branch that doesn't belong to the target page is rejected", async () => {
    const a = await signup("decouple-a@example.com");
    const b = await signup("decouple-b@example.com");

    const spaceA = await createSpace(a.cookie, "SA");
    const pageA = await createPage(a.cookie, spaceA, "pa");
    const spaceB = await createSpace(b.cookie, "SB");
    const pageB = await createPage(b.cookie, spaceB, "pb");

    // B gives their page real content.
    const fetchedB = await app.inject({ method: "GET", url: `/api/branches/${pageB.branchId}/page`, headers: { cookie: b.cookie } });
    const before = JSON.parse(fetchedB.body);
    await app.inject({
      method: "PUT",
      url: `/api/pages/${pageB.pageId}/branches/${pageB.branchId}`,
      headers: { cookie: b.cookie },
      payload: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "SECRET B" }] }] }, expectedUpdatedAt: before.updatedAt },
    });

    // A cannot read B's page directly.
    const denied = await app.inject({ method: "GET", url: `/api/branches/${pageB.branchId}/page`, headers: { cookie: a.cookie } });
    expect(denied.statusCode).toBe(403);

    // A tries to overwrite B's page through A's OWN branch - must be rejected.
    const overwrite = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageB.pageId}/branches/${pageA.branchId}`,
      headers: { cookie: a.cookie },
      payload: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "HACKED" }] }] }, expectedUpdatedAt: before.updatedAt },
    });
    expect(overwrite.statusCode).toBe(404);

    // B's content is untouched.
    const refetched = await app.inject({ method: "GET", url: `/api/branches/${pageB.branchId}/page`, headers: { cookie: b.cookie } });
    const body = JSON.stringify(JSON.parse(refetched.body).content);
    expect(body).toContain("SECRET B");
    expect(body).not.toContain("HACKED");
  });

  it("snapshot and history through a mismatched branch are rejected too", async () => {
    const a = await signup("decouple-c@example.com");
    const b = await signup("decouple-d@example.com");

    const spaceA = await createSpace(a.cookie, "SA2");
    const pageA = await createPage(a.cookie, spaceA, "pa2");
    const spaceB = await createSpace(b.cookie, "SB2");
    const pageB = await createPage(b.cookie, spaceB, "pb2");

    const snap = await app.inject({
      method: "POST",
      url: `/api/pages/${pageB.pageId}/branches/${pageA.branchId}/snapshot`,
      headers: { cookie: a.cookie },
      payload: { message: "leak" },
    });
    expect(snap.statusCode).toBe(404);

    const hist = await app.inject({
      method: "GET",
      url: `/api/pages/${pageB.pageId}/branches/${pageA.branchId}/history`,
      headers: { cookie: a.cookie },
    });
    expect(hist.statusCode).toBe(404);
  });
});

describe("API token bearer authentication", () => {
  it("account-scoped edit token acts as its creator on branch routes", async () => {
    const owner = await signup("tokenowner@example.com");
    const spaceId = await createSpace(owner.cookie, "TS");
    const page = await createPage(owner.cookie, spaceId, "tp");

    const { token } = await createApiToken(owner.cookie, { scopeType: "account", scopeId: null, permission: "edit", expiresAt: FUTURE });

    const get = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/page`, headers: { authorization: `Bearer ${token}` } });
    expect(get.statusCode).toBe(200);

    const body = JSON.parse(get.body);
    const put = await app.inject({
      method: "PUT",
      url: `/api/pages/${page.pageId}/branches/${page.branchId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "via token" }] }] }, expectedUpdatedAt: body.updatedAt },
    });
    expect(put.statusCode).toBe(200);
  });

  it("account-scoped view token is capped at viewer - cannot save", async () => {
    const owner = await signup("tokenowner2@example.com");
    const spaceId = await createSpace(owner.cookie, "TS2");
    const page = await createPage(owner.cookie, spaceId, "tp2");

    const { token } = await createApiToken(owner.cookie, { scopeType: "account", scopeId: null, permission: "view", expiresAt: FUTURE });

    const get = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/page`, headers: { authorization: `Bearer ${token}` } });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body);

    const put = await app.inject({
      method: "PUT",
      url: `/api/pages/${page.pageId}/branches/${page.branchId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: { type: "doc", content: [] }, expectedUpdatedAt: body.updatedAt },
    });
    expect(put.statusCode).toBe(403);
  });

  it("account-scoped admin token can use admin routes", async () => {
    const owner = await signup("tokenadmin@example.com");
    const { db } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.userId));

    const { token } = await createApiToken(owner.cookie, { scopeType: "account", scopeId: null, permission: "admin", expiresAt: FUTURE });

    const res = await app.inject({ method: "GET", url: "/api/settings", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it("branch-scoped token grants access to that branch only", async () => {
    const owner = await signup("tokenowner3@example.com");
    const spaceId = await createSpace(owner.cookie, "TS3");
    const page = await createPage(owner.cookie, spaceId, "tp3");
    const other = await createPage(owner.cookie, spaceId, "other3");

    const { token } = await createApiToken(owner.cookie, { scopeType: "branch", scopeId: page.branchId, permission: "edit", expiresAt: FUTURE });

    const ok = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/page`, headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);

    const outOfScope = await app.inject({ method: "GET", url: `/api/branches/${other.branchId}/page`, headers: { authorization: `Bearer ${token}` } });
    expect(outOfScope.statusCode).toBe(403);

    // Branch-scoped tokens are scoped credentials, not general logins.
    const spaces = await app.inject({ method: "GET", url: "/api/spaces", headers: { authorization: `Bearer ${token}` } });
    expect(spaces.statusCode).toBe(403);
  });

  it("space-scoped token grants access within that space only", async () => {
    const owner = await signup("tokenowner4@example.com");
    const spaceId = await createSpace(owner.cookie, "TS4");
    const otherSpaceId = await createSpace(owner.cookie, "TS4b");
    const page = await createPage(owner.cookie, spaceId, "tp4");
    const otherPage = await createPage(owner.cookie, otherSpaceId, "op4");

    const { token } = await createApiToken(owner.cookie, { scopeType: "space", scopeId: spaceId, permission: "view", expiresAt: FUTURE });

    const inSpace = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/page`, headers: { authorization: `Bearer ${token}` } });
    expect(inSpace.statusCode).toBe(200);

    const outOfSpace = await app.inject({ method: "GET", url: `/api/branches/${otherPage.branchId}/page`, headers: { authorization: `Bearer ${token}` } });
    expect(outOfSpace.statusCode).toBe(403);

    const tree = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/tree`, headers: { authorization: `Bearer ${token}` } });
    expect(tree.statusCode).toBe(200);

    // A view-permission token can't save even inside its space.
    const body = JSON.parse(inSpace.body);
    const put = await app.inject({
      method: "PUT",
      url: `/api/pages/${page.pageId}/branches/${page.branchId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: { type: "doc", content: [] }, expectedUpdatedAt: body.updatedAt },
    });
    expect(put.statusCode).toBe(403);
  });

  it("an invalid token or a password-protected share link is rejected as a bearer credential", async () => {
    const invalid = await app.inject({ method: "GET", url: "/api/spaces", headers: { authorization: "Bearer whk_definitely-not-real" } });
    expect(invalid.statusCode).toBe(401);

    const owner = await signup("tokensec@example.com");
    const spaceId = await createSpace(owner.cookie, "TSS");
    const page = await createPage(owner.cookie, spaceId, "tss");

    const link = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/share-links`,
      headers: { cookie: owner.cookie },
      payload: { scopeType: "branch", scopeId: page.branchId, permission: "view", expiresAt: FUTURE, password: "hunter2" },
    });
    expect(link.statusCode).toBe(201);
    const { token } = JSON.parse(link.body);

    const asBearer = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/page`, headers: { authorization: `Bearer ${token}` } });
    expect(asBearer.statusCode).toBe(401);
  });
});
