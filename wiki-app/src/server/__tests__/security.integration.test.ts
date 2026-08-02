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

describe("token scope validation - no minting tokens for content you can't access", () => {
  it("a non-admin cannot create an account-scoped admin token", async () => {
    const u = await signup("tokesc@example.com");
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: u.cookie },
      payload: { scopeType: "account", scopeId: null, permission: "admin", expiresAt: FUTURE },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a user cannot create a branch-scoped token for a branch they have no access to", async () => {
    const a = await signup("tokescA@example.com");
    const aSpace = await createSpace(a.cookie, "TokA-space");
    const page = await createPage(a.cookie, aSpace, "tok-a");

    const b = await signup("tokescB@example.com");
    await createSpace(b.cookie, "TokB-space");

    const denied = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: b.cookie },
      payload: { scopeType: "branch", scopeId: page.branchId, permission: "edit", expiresAt: FUTURE },
    });
    expect(denied.statusCode).toBe(403);

    // The owner (space admin) can still mint a token for their own branch.
    const allowed = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: a.cookie },
      payload: { scopeType: "branch", scopeId: page.branchId, permission: "edit", expiresAt: FUTURE },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("a user cannot create a space-scoped token for a space they have no role in", async () => {
    const a = await signup("tokescC@example.com");
    const aSpace = await createSpace(a.cookie, "TokC-space");

    const b = await signup("tokescD@example.com");
    const bSpace = await createSpace(b.cookie, "TokD-space");

    const denied = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: b.cookie },
      payload: { scopeType: "space", scopeId: aSpace, permission: "view", expiresAt: FUTURE },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: b.cookie },
      payload: { scopeType: "space", scopeId: bSpace, permission: "view", expiresAt: FUTURE },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("share links are cross-checked against the URL's branch - cannot scope to another branch", async () => {
    const a = await signup("tokescE@example.com");
    const aSpace = await createSpace(a.cookie, "TokE-space");
    const page = await createPage(a.cookie, aSpace, "tok-e");

    const b = await signup("tokescF@example.com");
    const bSpace = await createSpace(b.cookie, "TokF-space");

    // b has editor on... nothing. First prove the URL witness alone is not enough:
    const denied = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/share-links`,
      headers: { cookie: b.cookie },
      payload: { scopeType: "branch", scopeId: page.branchId, permission: "view", expiresAt: FUTURE },
    });
    // b has no editor access on the URL branch either, so the middleware denies it.
    expect(denied.statusCode).toBe(403);

    // Now the real bug class: b is made editor on a DIFFERENT branch they own,
    // then tries to use that URL as a witness to mint a link for a's branch.
    const bPage = await createPage(b.cookie, bSpace, "tok-f");
    const forged = await app.inject({
      method: "POST",
      url: `/api/branches/${bPage.branchId}/share-links`,
      headers: { cookie: b.cookie },
      payload: { scopeType: "branch", scopeId: page.branchId, permission: "view", expiresAt: FUTURE },
    });
    expect(forged.statusCode).toBe(403); // scopeId != URL branch, no editor access on target
  });

  it("minting an admin token still works for a global admin (no regression)", async () => {
    const owner = await signup("tokescG@example.com");
    const { db } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.userId));

    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: owner.cookie },
      payload: { scopeType: "account", scopeId: null, permission: "admin", expiresAt: FUTURE },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("MCP tools enforce the same permissions as REST routes", () => {
  function mcpCall(cookie: string, name: string, args: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { cookie },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
  }

  function resultOf(res: { statusCode: number; body: string }) {
    return JSON.parse(JSON.parse(res.body).result.content[0].text);
  }

  it("list_spaces only returns spaces the caller can access", async () => {
    const a = await signup("mcpa@example.com");
    const aSpace = await createSpace(a.cookie, "A-space");
    await createPage(a.cookie, aSpace, "a-page");

    const b = await signup("mcpb@example.com");
    await createSpace(b.cookie, "B-space");

    const forB = await mcpCall(b.cookie, "list_spaces");
    expect(forB.statusCode).toBe(200);
    const names = resultOf(forB).map((s: { name: string }) => s.name);
    expect(names).toContain("B-space");
    expect(names).not.toContain("A-space");
  });

  it("get_page hides branches the caller cannot view (404, no existence leak)", async () => {
    const a = await signup("mcpc@example.com");
    const aSpace = await createSpace(a.cookie, "C-space");
    const page = await createPage(a.cookie, aSpace, "c-page");

    const b = await signup("mcpd@example.com");
    await createSpace(b.cookie, "D-space");

    const hidden = await mcpCall(b.cookie, "get_page", { branchId: page.branchId });
    expect(hidden.statusCode).toBe(200);
    expect(JSON.parse(hidden.body).error).toBeDefined();

    const visible = await mcpCall(a.cookie, "get_page", { branchId: page.branchId });
    expect(visible.statusCode).toBe(200);
    expect(resultOf(visible).slug).toBe("c-page");
  });

  it("create_page requires editor access on the target space", async () => {
    const a = await signup("mcpe@example.com");
    const aSpace = await createSpace(a.cookie, "E-space");

    const b = await signup("mcpf@example.com");
    await createSpace(b.cookie, "F-space");

    const denied = await mcpCall(b.cookie, "create_page", { slug: "x", title: "X", spaceId: aSpace, content: "" });
    expect(denied.statusCode).toBe(200);
    expect(JSON.parse(denied.body).error).toBeDefined();

    const allowed = await mcpCall(a.cookie, "create_page", { slug: "ok", title: "OK", spaceId: aSpace, content: "hi" });
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body).error).toBeUndefined();
  });

  it("get_page_tree hides spaces the caller has no role in", async () => {
    const a = await signup("mcpg@example.com");
    const aSpace = await createSpace(a.cookie, "G-space");
    await createPage(a.cookie, aSpace, "g-page");

    const b = await signup("mcph@example.com");
    await createSpace(b.cookie, "H-space");

    const hidden = await mcpCall(b.cookie, "get_page_tree", { spaceId: aSpace });
    expect(hidden.statusCode).toBe(200);
    expect(JSON.parse(hidden.body).error).toBeDefined();

    const visible = await mcpCall(a.cookie, "get_page_tree", { spaceId: aSpace });
    expect(visible.statusCode).toBe(200);
    expect(resultOf(visible).length).toBeGreaterThan(0);
  });
});
