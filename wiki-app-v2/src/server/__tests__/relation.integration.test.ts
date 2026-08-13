import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-relation-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-relation-repo-${randomBytes(4).toString("hex")}`;
process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  const { initGitRepo } = await import("../services/git.service.js");
  await initGitRepo();
  const { buildApp } = await import("../app.js");
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  const { closeDb } = await import("../db/index.js");
  closeDb();
  rmSync(DB_PATH, { force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

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
    payload: { email, password: "test-password-1234", name: email.split("@")[0]! },
  });
  expect(res.statusCode).toBe(200);
  const cookie = extractCookie(res.headers["set-cookie"]);
  const body = res.json() as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

async function makeAdmin(userId: string): Promise<void> {
  const { getDb } = await import("../db/index.js");
  const { users } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  await getDb().db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/spaces",
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createPage(
  cookie: string,
  spaceId: string,
  slug: string,
  title: string,
): Promise<{ pageId: string; branchId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug, title },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

async function addMember(cookie: string, spaceId: string, userId: string, role: "viewer" | "editor"): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/members`,
    headers: { cookie },
    payload: { userId, role },
  });
  expect(res.statusCode).toBe(201);
}

async function createRelation(
  cookie: string,
  fromPageId: string,
  type: string,
  toPageId: string,
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: `/api/pages/${fromPageId}/relations`,
    headers: { cookie },
    payload: { type, toPageId },
  });
  return res.statusCode;
}

async function listOwned(cookie: string, pageId: string): Promise<unknown[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/pages/${pageId}/relations`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { owned: unknown[] }).owned;
}

async function listIncoming(cookie: string, pageId: string): Promise<unknown[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/pages/${pageId}/relations/incoming`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { incoming: unknown[] }).incoming;
}

interface OwnedRelationRow {
  id: string;
  type: string;
  target: { id: string; title: string; branchId: string | null } | null;
}

interface IncomingRelationRow {
  id: string;
  type: string;
  source: { id: string; title: string; branchId: string | null } | null;
}

describe("relations (brief §13.1)", () => {
  it("creates a relation between two readable pages and lists it owned", async () => {
    const me = await signup(`rel-a-${randomBytes(4).toString("hex")}@x.com`);
    const space = await createSpace(me.cookie, "OwnedSpace");
    const a = await createPage(me.cookie, space, "alpha", "Alpha");
    const b = await createPage(me.cookie, space, "beta", "Beta");

    const status = await createRelation(me.cookie, a.pageId, "depends on", b.pageId);
    expect(status).toBe(201);

    const owned = (await listOwned(me.cookie, a.pageId)) as OwnedRelationRow[];
    expect(owned).toHaveLength(1);
    expect(owned[0]!.type).toBe("depends on");
    expect(owned[0]!.target?.id).toBe(b.pageId);
    expect(owned[0]!.target?.title).toBe("Beta");
    // slice-26: the relation target also carries a branchId the UI can
    // navigate to — when the target has a readable branch, this is set.
    expect(owned[0]!.target?.branchId).toBe(b.branchId);
  });

  it("shows the same relation in the target's incoming list with branchId", async () => {
    const me = await signup(`rel-b-${randomBytes(4).toString("hex")}@x.com`);
    const space = await createSpace(me.cookie, "IncSpace");
    const a = await createPage(me.cookie, space, "alpha", "Alpha");
    const b = await createPage(me.cookie, space, "beta", "Beta");
    await createRelation(me.cookie, a.pageId, "supersedes", b.pageId);

    const incoming = (await listIncoming(me.cookie, b.pageId)) as IncomingRelationRow[];
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.type).toBe("supersedes");
    expect(incoming[0]!.source?.id).toBe(a.pageId);
    expect(incoming[0]!.source?.title).toBe("Alpha");
    expect(incoming[0]!.source?.branchId).toBe(a.branchId);
  });

  it("omits owned relations whose target page the caller cannot read (no existence leak)", async () => {
    const owner = await signup(`rel-c-owner-${randomBytes(4).toString("hex")}@x.com`);
    const other = await signup(`rel-c-out-${randomBytes(4).toString("hex")}@x.com`);
    const privateSpace = await createSpace(owner.cookie, "PrivateSpace");
    const sharedSpace = await createSpace(owner.cookie, "SharedSpace");
    const src = await createPage(owner.cookie, sharedSpace, "src", "Source");
    const hiddenTarget = await createPage(owner.cookie, privateSpace, "hidden", "Hidden Target");
    const visibleTarget = await createPage(owner.cookie, sharedSpace, "visible", "Visible Target");

    // both relations created by owner (who can read everything)
    await createRelation(owner.cookie, src.pageId, "depends on", hiddenTarget.pageId);
    await createRelation(owner.cookie, src.pageId, "supersedes", visibleTarget.pageId);

    // give `other` viewer role in sharedSpace but NOT in privateSpace
    await addMember(owner.cookie, sharedSpace, other.userId, "viewer");

    const otherView = (await listOwned(other.cookie, src.pageId)) as OwnedRelationRow[];
    const types = otherView.map((r) => r.type).sort();
    // The hidden relation must not appear at all — that's the brief's
    // "no existence leak" semantic.
    expect(types).toEqual(["supersedes"]);
    // And because `other` can't read the hidden target page, fetching
    // its incoming list returns 404 ("page not found") rather than an
    // empty array. The endpoint refuses to confirm that the page
    // exists.
    const hiddenRes = await app.inject({
      method: "GET",
      url: `/api/pages/${hiddenTarget.pageId}/relations/incoming`,
      headers: { cookie: other.cookie },
    });
    expect(hiddenRes.statusCode).toBe(404);
  });

  it("omits incoming relations whose source page the caller cannot read", async () => {
    const owner = await signup(`rel-d-owner-${randomBytes(4).toString("hex")}@x.com`);
    const other = await signup(`rel-d-out-${randomBytes(4).toString("hex")}@x.com`);
    const privateSpace = await createSpace(owner.cookie, "OwnerPrivate");
    const sharedSpace = await createSpace(owner.cookie, "OwnerShared");

    const hiddenSource = await createPage(owner.cookie, privateSpace, "hidden-source", "Hidden Source");
    const visibleSource = await createPage(owner.cookie, sharedSpace, "visible-source", "Visible Source");
    const target = await createPage(owner.cookie, sharedSpace, "target", "Target");

    await createRelation(owner.cookie, hiddenSource.pageId, "depends on", target.pageId);
    await createRelation(owner.cookie, visibleSource.pageId, "supersedes", target.pageId);

    await addMember(owner.cookie, sharedSpace, other.userId, "viewer");

    const incoming = (await listIncoming(other.cookie, target.pageId)) as IncomingRelationRow[];
    const sourceIds = incoming.map((r) => r.source?.id).sort();
    expect(sourceIds).toEqual([visibleSource.pageId]);
  });

  it("refuses to create a relation to a page the caller cannot read", async () => {
    const owner = await signup(`rel-e-owner-${randomBytes(4).toString("hex")}@x.com`);
    const other = await signup(`rel-e-out-${randomBytes(4).toString("hex")}@x.com`);
    const sharedSpace = await createSpace(owner.cookie, "EShared");
    const privateSpace = await createSpace(owner.cookie, "EPrivate");
    const src = await createPage(owner.cookie, sharedSpace, "src", "Source");
    const hidden = await createPage(owner.cookie, privateSpace, "hidden", "Hidden");
    await addMember(owner.cookie, sharedSpace, other.userId, "editor");

    const status = await createRelation(other.cookie, src.pageId, "depends on", hidden.pageId);
    expect(status).toBe(400);
    // owner can still see the source page has no relations
    const owned = await listOwned(owner.cookie, src.pageId);
    expect(owned).toHaveLength(0);
  });

  it("refuses to create a relation from a page the caller cannot edit", async () => {
    const owner = await signup(`rel-f-owner-${randomBytes(4).toString("hex")}@x.com`);
    const viewer = await signup(`rel-f-view-${randomBytes(4).toString("hex")}@x.com`);
    const space = await createSpace(owner.cookie, "F");
    const a = await createPage(owner.cookie, space, "a", "A");
    const b = await createPage(owner.cookie, space, "b", "B");
    await addMember(owner.cookie, space, viewer.userId, "viewer");

    const status = await createRelation(viewer.cookie, a.pageId, "depends on", b.pageId);
    expect(status).toBe(403);
  });

  it("rejects duplicate (page, type, target)", async () => {
    const me = await signup(`rel-g-${randomBytes(4).toString("hex")}@x.com`);
    const space = await createSpace(me.cookie, "G");
    const a = await createPage(me.cookie, space, "a", "A");
    const b = await createPage(me.cookie, space, "b", "B");
    expect(await createRelation(me.cookie, a.pageId, "depends on", b.pageId)).toBe(201);
    expect(await createRelation(me.cookie, a.pageId, "depends on", b.pageId)).toBe(400);
    // same type, different target: allowed
    const c = await createPage(me.cookie, space, "c", "C");
    expect(await createRelation(me.cookie, a.pageId, "depends on", c.pageId)).toBe(201);
  });

  it("rejects self-relations and empty / oversized / bad-char types", async () => {
    const me = await signup(`rel-h-${randomBytes(4).toString("hex")}@x.com`);
    const space = await createSpace(me.cookie, "H");
    const a = await createPage(me.cookie, space, "a", "A");
    const b = await createPage(me.cookie, space, "b", "B");
    expect(await createRelation(me.cookie, a.pageId, "self", a.pageId)).toBe(400);
    expect(await createRelation(me.cookie, a.pageId, "", b.pageId)).toBe(400);
    // leading/trailing whitespace is rejected
    expect(await createRelation(me.cookie, a.pageId, " leading", b.pageId)).toBe(400);
    expect(await createRelation(me.cookie, a.pageId, "trailing ", b.pageId)).toBe(400);
    // Trilium-like free-form names with internal spaces are allowed
    expect(await createRelation(me.cookie, a.pageId, "depends on", b.pageId)).toBe(201);
    expect(await createRelation(me.cookie, a.pageId, "is a component of", a.pageId)).toBe(400);
    // 64 chars OK, 65 not OK
    const ok = "a".repeat(64);
    expect(await createRelation(me.cookie, a.pageId, ok, b.pageId)).toBe(201);
    const big = "a".repeat(65);
    expect(await createRelation(me.cookie, a.pageId, big, b.pageId)).toBe(400);
  });

  it("rejects creating a relation pointing at a non-existent page", async () => {
    const me = await signup(`rel-i-${randomBytes(4).toString("hex")}@x.com`);
    const space = await createSpace(me.cookie, "I");
    const a = await createPage(me.cookie, space, "a", "A");
    const status = await createRelation(me.cookie, a.pageId, "depends on", "ghost-page");
    expect(status).toBe(400);
  });

  it("admin can edit relations on any page; only admin or source-editor can delete", async () => {
    const owner = await signup(`rel-j-owner-${randomBytes(4).toString("hex")}@x.com`);
    const editor = await signup(`rel-j-ed-${randomBytes(4).toString("hex")}@x.com`);
    const admin = await signup(`rel-j-adm-${randomBytes(4).toString("hex")}@x.com`);
    await makeAdmin(admin.userId);
    const space = await createSpace(owner.cookie, "J");
    await addMember(owner.cookie, space, editor.userId, "editor");
    const a = await createPage(owner.cookie, space, "a", "A");
    const b = await createPage(owner.cookie, space, "b", "B");

    // admin creates the relation (a has owner==`owner`; admin can override)
    expect(await createRelation(admin.cookie, a.pageId, "depends on", b.pageId)).toBe(201);

    const owned = (await listOwned(admin.cookie, a.pageId)) as OwnedRelationRow[];
    const relId = owned[0]!.id;

    // editor (who can edit `a`) can delete the relation
    const delEditor = await app.inject({
      method: "DELETE",
      url: `/api/pages/${a.pageId}/relations/${relId}`,
      headers: { cookie: editor.cookie },
    });
    expect(delEditor.statusCode).toBe(204);

    // re-create then have a non-editor user try to delete
    await createRelation(owner.cookie, a.pageId, "depends on", b.pageId);
    const owned2 = (await listOwned(owner.cookie, a.pageId)) as OwnedRelationRow[];
    const relId2 = owned2[0]!.id;

    const nonEditor = await signup(`rel-j-other-${randomBytes(4).toString("hex")}@x.com`);
    await addMember(owner.cookie, space, nonEditor.userId, "viewer");
    const delFail = await app.inject({
      method: "DELETE",
      url: `/api/pages/${a.pageId}/relations/${relId2}`,
      headers: { cookie: nonEditor.cookie },
    });
    expect(delFail.statusCode).toBe(403);

    // admin can delete
    const delAdmin = await app.inject({
      method: "DELETE",
      url: `/api/pages/${a.pageId}/relations/${relId2}`,
      headers: { cookie: admin.cookie },
    });
    expect(delAdmin.statusCode).toBe(204);
  });
});