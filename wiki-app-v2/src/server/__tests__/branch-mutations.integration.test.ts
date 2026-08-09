import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-6 gate: branch mutations (clone, move, remove placement, rename, delete
// page everywhere). This is the ported regression suite from the old app
// (wiki-app/src/server/__tests__/page-branch-mutations.integration.test.ts),
// adapted to the v2 URL shapes. The old bugs these guard against:
//   - cloning must reuse the SAME page row (pages/branches split, §3.1)
//   - destination permission must be checked, not just the source
//   - move must reject cycles and cross-space reparenting
//   - a placement with children must not be removable (children would dangle)
//   - deleting a page everywhere requires editor access on EVERY placement
// Env vars MUST be set before the app module is imported.
const DB_PATH = `data/test-mutations-${randomBytes(4).toString("hex")}.db`;

process.env.DB_PATH = DB_PATH;
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
    payload: { name: "T", email, password: "correct-horse-battery-staple" },
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

async function createPage(cookie: string, spaceId: string, slug: string, parentBranchId: string | null = null) {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug, parentBranchId },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

async function getBranchPage(cookie: string, branchId: string) {
  return app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
}

async function spaceTree(cookie: string, spaceId: string): Promise<{ id: string; pageId: string; slug: string; children: any[] }[]> {
  const res = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/tree`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

function flattenTree(nodes: { slug: string; children: any[] }[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.slug);
    out.push(...flattenTree(n.children));
  }
  return out;
}

async function addSpaceMember(spaceId: string, userId: string, role: "viewer" | "editor" | "admin") {
  const { getDb } = await import("../db/index.js");
  const { spaceMembers } = await import("../db/schema.js");
  await getDb().db.insert(spaceMembers).values({ spaceId, userId, role });
}

async function addBranchGrant(branchId: string, groupId: string, role: "viewer" | "editor") {
  const { getDb } = await import("../db/index.js");
  const { groupPermissions } = await import("../db/schema.js");
  await getDb().db.insert(groupPermissions).values({ branchId, groupId, role });
}

/** Inserts a system branch for the given page (the kind used by Trash, §3.1a). */
async function insertSystemBranch(pageId: string, spaceId: string, userId: string): Promise<string> {
  const { getDb } = await import("../db/index.js");
  const { branches } = await import("../db/schema.js");
  const id = crypto.randomUUID();
  await getDb().db.insert(branches).values({ id, pageId, spaceId, visibility: "private", isSystem: true, createdBy: userId });
  return id;
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  // Reset singletons from a previous test file (vitest runs sequentially).
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

describe("POST /api/branches/:branchId/clone", () => {
  it("clones a page into another space sharing the same content", async () => {
    const a = await signup("clone-a@example.com");
    const s1 = await createSpace(a.cookie, "S1");
    const s2 = await createSpace(a.cookie, "S2");
    const page = await createPage(a.cookie, s1, "shared");

    // Give the page real content first.
    const fetched = await getBranchPage(a.cookie, page.branchId);
    const { updatedAt } = fetched.json();
    await app.inject({
      method: "PUT",
      url: `/api/branches/${page.branchId}/page/content`,
      headers: { cookie: a.cookie },
      payload: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "shared body" }] }] }, expectedUpdatedAt: updatedAt },
    });

    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: null },
    });
    expect(clone.statusCode).toBe(201);
    const { branchId: newBranchId, pageId } = clone.json();
    expect(pageId).toBe(page.pageId);
    expect(newBranchId).not.toBe(page.branchId);

    const viaClone = await getBranchPage(a.cookie, newBranchId);
    expect(viaClone.statusCode).toBe(200);
    expect(JSON.stringify(viaClone.json().content)).toContain("shared body");

    const tree = await spaceTree(a.cookie, s2);
    expect(flattenTree(tree)).toContain("shared");
  });

  it("rejects a clone when the caller has no editor access on the destination space", async () => {
    const a = await signup("clone-b@example.com");
    const b = await signup("clone-b2@example.com");
    const s1 = await createSpace(a.cookie, "S1b");
    const s2 = await createSpace(a.cookie, "S2b");
    const page = await createPage(a.cookie, s1, "p");

    await addSpaceMember(s1, b.userId, "viewer"); // B can SEE the source (passes source check)...
    // ...but has no role in s2, so the destination check must fail.

    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/clone`,
      headers: { cookie: b.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: null },
    });
    expect(clone.statusCode).toBe(403);
  });

  it("nests the clone under a parent branch in the target space", async () => {
    const a = await signup("clone-c@example.com");
    const s1 = await createSpace(a.cookie, "S1c");
    const s2 = await createSpace(a.cookie, "S2c");
    const page = await createPage(a.cookie, s1, "p");
    const parent = await createPage(a.cookie, s2, "parent");

    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: parent.branchId },
    });
    expect(clone.statusCode).toBe(201);

    const tree = await spaceTree(a.cookie, s2);
    const parentNode = tree.find((n) => n.slug === "parent")!;
    expect(parentNode.children.map((c) => c.slug)).toContain("p");
  });

  it("rejects a target parent that isn't in the target space", async () => {
    const a = await signup("clone-d@example.com");
    const s1 = await createSpace(a.cookie, "S1d");
    const s2 = await createSpace(a.cookie, "S2d");
    const s3 = await createSpace(a.cookie, "S3d");
    const page = await createPage(a.cookie, s1, "p");
    const parent = await createPage(a.cookie, s3, "parent");

    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: parent.branchId },
    });
    expect(clone.statusCode).toBe(400);
  });

  it("404s for a nonexistent source branch", async () => {
    const a = await signup("clone-e@example.com");
    const s2 = await createSpace(a.cookie, "S2e");
    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${crypto.randomUUID()}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: null },
    });
    expect(clone.statusCode).toBe(404);
  });

  it("rejects cloning a system (trash) branch", async () => {
    const a = await signup("clone-f@example.com");
    const s1 = await createSpace(a.cookie, "S1f");
    const s2 = await createSpace(a.cookie, "S2f");
    const page = await createPage(a.cookie, s1, "p");
    const sysBranchId = await insertSystemBranch(page.pageId, s1, a.userId);

    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${sysBranchId}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: null },
    });
    expect(clone.statusCode).toBe(403);
  });
});

describe("PUT /api/branches/:branchId/move", () => {
  it("moves a nested page to the space root", async () => {
    const a = await signup("move-a@example.com");
    const s1 = await createSpace(a.cookie, "S1m");
    const parent = await createPage(a.cookie, s1, "parent");
    const child = await createPage(a.cookie, s1, "child", parent.branchId);

    const move = await app.inject({
      method: "PUT",
      url: `/api/branches/${child.branchId}/move`,
      headers: { cookie: a.cookie },
      payload: { newParentBranchId: null },
    });
    expect(move.statusCode).toBe(200);

    const tree = await spaceTree(a.cookie, s1);
    expect(flattenTree(tree)).toContain("child");
    expect(tree.map((n) => n.slug)).toContain("child"); // now a root
  });

  it("moves a root page under another page", async () => {
    const a = await signup("move-b@example.com");
    const s1 = await createSpace(a.cookie, "S1m2");
    const p1 = await createPage(a.cookie, s1, "p1");
    const p2 = await createPage(a.cookie, s1, "p2");

    const move = await app.inject({
      method: "PUT",
      url: `/api/branches/${p1.branchId}/move`,
      headers: { cookie: a.cookie },
      payload: { newParentBranchId: p2.branchId },
    });
    expect(move.statusCode).toBe(200);

    const tree = await spaceTree(a.cookie, s1);
    const p2Node = tree.find((n) => n.slug === "p2")!;
    expect(p2Node.children.map((c) => c.slug)).toContain("p1");
  });

  it("rejects moving a branch under its own descendant (cycle)", async () => {
    const a = await signup("move-c@example.com");
    const s1 = await createSpace(a.cookie, "S1m3");
    const p1 = await createPage(a.cookie, s1, "p1");
    const p2 = await createPage(a.cookie, s1, "p2", p1.branchId);
    const p3 = await createPage(a.cookie, s1, "p3", p2.branchId);

    const move = await app.inject({
      method: "PUT",
      url: `/api/branches/${p1.branchId}/move`,
      headers: { cookie: a.cookie },
      payload: { newParentBranchId: p3.branchId },
    });
    expect(move.statusCode).toBe(400);
  });

  it("rejects moving a branch under itself", async () => {
    const a = await signup("move-d@example.com");
    const s1 = await createSpace(a.cookie, "S1m4");
    const p1 = await createPage(a.cookie, s1, "p1");

    const move = await app.inject({
      method: "PUT",
      url: `/api/branches/${p1.branchId}/move`,
      headers: { cookie: a.cookie },
      payload: { newParentBranchId: p1.branchId },
    });
    expect(move.statusCode).toBe(400);
  });

  it("rejects cross-space moves", async () => {
    const a = await signup("move-e@example.com");
    const s1 = await createSpace(a.cookie, "S1m5");
    const s2 = await createSpace(a.cookie, "S2m5");
    const p1 = await createPage(a.cookie, s1, "p1");
    const p2 = await createPage(a.cookie, s2, "p2");

    const move = await app.inject({
      method: "PUT",
      url: `/api/branches/${p1.branchId}/move`,
      headers: { cookie: a.cookie },
      payload: { newParentBranchId: p2.branchId },
    });
    expect(move.statusCode).toBe(400);
  });

  it("rejects a viewer moving a page (source check)", async () => {
    const a = await signup("move-f@example.com");
    const b = await signup("move-f2@example.com");
    const s1 = await createSpace(a.cookie, "S1m6");
    const p1 = await createPage(a.cookie, s1, "p1");

    await addSpaceMember(s1, b.userId, "viewer");
    const move = await app.inject({
      method: "PUT",
      url: `/api/branches/${p1.branchId}/move`,
      headers: { cookie: b.cookie },
      payload: { newParentBranchId: null },
    });
    expect(move.statusCode).toBe(403);
  });

  it("rejects a move when the new parent has a branch-level grant the user lacks", async () => {
    const a = await signup("move-g@example.com");
    const b = await signup("move-g2@example.com");
    const s1 = await createSpace(a.cookie, "S1m7");
    const p1 = await createPage(a.cookie, s1, "p1"); // no branch grant -> B's space role (editor) applies
    const locked = await createPage(a.cookie, s1, "locked"); // branch-level grant for group G only

    await addSpaceMember(s1, b.userId, "editor");
    const { getDb } = await import("../db/index.js");
    const { groups } = await import("../db/schema.js");
    const gid = crypto.randomUUID();
    await getDb().db.insert(groups).values({ id: gid, name: "g-locked" });
    await addBranchGrant(locked.branchId, gid, "editor");

    const move = await app.inject({
      method: "PUT",
      url: `/api/branches/${p1.branchId}/move`,
      headers: { cookie: b.cookie },
      payload: { newParentBranchId: locked.branchId },
    });
    expect(move.statusCode).toBe(403);
  });
});

describe("DELETE /api/branches/:branchId (remove a placement)", () => {
  it("removes one placement without deleting the page or other placements", async () => {
    const a = await signup("del-a@example.com");
    const s1 = await createSpace(a.cookie, "S1d");
    const s2 = await createSpace(a.cookie, "S2d");
    const page = await createPage(a.cookie, s1, "p");
    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: null },
    });
    const { branchId: cloneBranchId } = clone.json();

    const del = await app.inject({ method: "DELETE", url: `/api/branches/${page.branchId}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(200);

    const s1Tree = await spaceTree(a.cookie, s1);
    expect(flattenTree(s1Tree)).not.toContain("p");
    // The other placement still serves the page.
    const stillThere = await getBranchPage(a.cookie, cloneBranchId);
    expect(stillThere.statusCode).toBe(200);
  });

  it("rejects removing a placement that still has child pages", async () => {
    const a = await signup("del-b@example.com");
    const s1 = await createSpace(a.cookie, "S1d2");
    const parent = await createPage(a.cookie, s1, "parent");
    await createPage(a.cookie, s1, "child", parent.branchId);

    const del = await app.inject({ method: "DELETE", url: `/api/branches/${parent.branchId}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(400);
  });

  it("rejects removing a system branch", async () => {
    const a = await signup("del-c@example.com");
    const s1 = await createSpace(a.cookie, "S1d3");
    const page = await createPage(a.cookie, s1, "p");
    const sysBranchId = await insertSystemBranch(page.pageId, s1, a.userId);

    const del = await app.inject({ method: "DELETE", url: `/api/branches/${sysBranchId}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(403);
  });
});

describe("DELETE /api/pages/:pageId (delete a page everywhere)", () => {
  it("soft-deletes the page and removes every placement", async () => {
    const a = await signup("delall-a@example.com");
    const s1 = await createSpace(a.cookie, "S1e");
    const s2 = await createSpace(a.cookie, "S2e");
    const page = await createPage(a.cookie, s1, "p");
    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: null },
    });
    const { branchId: cloneBranchId } = clone.json();

    const del = await app.inject({ method: "DELETE", url: `/api/pages/${page.pageId}?branchId=${page.branchId}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(200);

    // Both placements gone.
    for (const branchId of [page.branchId, cloneBranchId]) {
      const res = await getBranchPage(a.cookie, branchId);
      expect(res.statusCode).toBe(404);
    }
    // Page soft-deleted.
    const { getDb } = await import("../db/index.js");
    const { pages, branches } = await import("../db/schema.js");
    const [p] = await getDb().db.select().from(pages).where(eq(pages.id, page.pageId));
    expect(p!.deletedAt).not.toBeNull();
    const branchesLeft = await getDb().db.select().from(branches).where(eq(branches.pageId, page.pageId));
    expect(branchesLeft.length).toBe(0);
  });

  it("requires editor access on every placement, not just the witness branch", async () => {
    const a = await signup("delall-b@example.com");
    const b = await signup("delall-b2@example.com");
    const s1 = await createSpace(a.cookie, "S1e2");
    const s2 = await createSpace(a.cookie, "S2e2");
    const page = await createPage(a.cookie, s1, "p");
    const clone = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: s2, targetParentBranchId: null },
    });
    const { branchId: cloneBranchId } = clone.json();

    // B can edit the witness placement (s2) but only view the other (s1).
    await addSpaceMember(s2, b.userId, "editor");
    await addSpaceMember(s1, b.userId, "viewer");

    const del = await app.inject({ method: "DELETE", url: `/api/pages/${page.pageId}?branchId=${cloneBranchId}`, headers: { cookie: b.cookie } });
    expect(del.statusCode).toBe(403);

    // Page is untouched.
    const stillThere = await getBranchPage(a.cookie, page.branchId);
    expect(stillThere.statusCode).toBe(200);
  });

  it("rejects deleting a page whose placements still have children", async () => {
    const a = await signup("delall-c@example.com");
    const s1 = await createSpace(a.cookie, "S1e3");
    const parent = await createPage(a.cookie, s1, "parent");
    await createPage(a.cookie, s1, "child", parent.branchId);

    const del = await app.inject({ method: "DELETE", url: `/api/pages/${parent.pageId}?branchId=${parent.branchId}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(400);
  });

  it("400s when the authorization witness branchId is missing", async () => {
    const a = await signup("delall-d@example.com");
    const s1 = await createSpace(a.cookie, "S1e4");
    const page = await createPage(a.cookie, s1, "p");

    const del = await app.inject({ method: "DELETE", url: `/api/pages/${page.pageId}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(400);
  });
});

describe("PUT /api/pages/:pageId/branches/:branchId/slug (rename)", () => {
  it("renames a page and the new slug shows up everywhere", async () => {
    const a = await signup("ren-a@example.com");
    const s1 = await createSpace(a.cookie, "S1r");
    const page = await createPage(a.cookie, s1, "old-name");

    const rename = await app.inject({
      method: "PUT",
      url: `/api/pages/${page.pageId}/branches/${page.branchId}/slug`,
      headers: { cookie: a.cookie },
      payload: { slug: "new-name" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().slug).toBe("new-name");

    const fetched = await getBranchPage(a.cookie, page.branchId);
    expect(fetched.json().slug).toBe("new-name");
    const tree = await spaceTree(a.cookie, s1);
    expect(flattenTree(tree)).toContain("new-name");
    expect(flattenTree(tree)).not.toContain("old-name");
  });

  it("404s when the branch doesn't belong to the page (cross-branch rename)", async () => {
    const a = await signup("ren-b@example.com");
    const s1 = await createSpace(a.cookie, "S1r2");
    const p1 = await createPage(a.cookie, s1, "p1");
    const p2 = await createPage(a.cookie, s1, "p2");

    const rename = await app.inject({
      method: "PUT",
      url: `/api/pages/${p1.pageId}/branches/${p2.branchId}/slug`,
      headers: { cookie: a.cookie },
      payload: { slug: "nope" },
    });
    expect(rename.statusCode).toBe(404);
  });

  it("rejects a viewer renaming a page", async () => {
    const a = await signup("ren-c@example.com");
    const b = await signup("ren-c2@example.com");
    const s1 = await createSpace(a.cookie, "S1r3");
    const page = await createPage(a.cookie, s1, "p");
    await addSpaceMember(s1, b.userId, "viewer");

    const rename = await app.inject({
      method: "PUT",
      url: `/api/pages/${page.pageId}/branches/${page.branchId}/slug`,
      headers: { cookie: b.cookie },
      payload: { slug: "hacked" },
    });
    expect(rename.statusCode).toBe(403);
  });
});
