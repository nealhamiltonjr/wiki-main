import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Regression suite for the slice-9→10 code audit: cross-boundary data leaks
// (backlinks, placements, favorites), suspended-token enforcement, FK validation,
// and the spaces listing's defaultRole gap. Each fix is exercised through the
// real route layer (Fastify inject), matching how a malicious client would hit it.

const DB_PATH = `data/test-audit-fixes-${randomBytes(4).toString("hex")}.db`;

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

async function getPage(cookie: string, branchId: string) {
  const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; updatedAt: string; content: unknown };
}

async function saveContent(cookie: string, branchId: string, content: unknown, updatedAt: string) {
  const res = await app.inject({
    method: "PUT",
    url: `/api/branches/${branchId}/page/content`,
    headers: { cookie },
    payload: { content, expectedUpdatedAt: updatedAt },
  });
  expect(res.statusCode).toBe(200);
}

function linkTo(href: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "blk-audit" },
        content: [
          { type: "text", text: "link", marks: [{ type: "link", attrs: { href } }] },
        ],
      },
    ],
  };
}

beforeAll(async () => {
  const root = process.cwd();
  if (!existsSync(`${root}/data`)) mkdirSync(`${root}/data`, { recursive: true });
  const { buildApp } = await import("../app.js");
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  const { closeDb } = await import("../db/index.js");
  closeDb();
  if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true });
});

describe("backlink cross-boundary leaks (§13.1)", () => {
  it("hides backlinks whose source page the caller cannot access", async () => {
    const a = await signup("audit-bl-a@example.com");
    const b = await signup("audit-bl-b@example.com");

    // A's open space (defaultRole editor → B can read it) and private space.
    const openSpace = await createSpace(a.cookie, "Open");
    await app.inject({
      method: "PUT",
      url: `/api/spaces/${openSpace}/default-role`,
      headers: { cookie: a.cookie },
      payload: { defaultRole: "editor" },
    });
    const privateSpace = await createSpace(a.cookie, "Private");

    const pub = await createPage(a.cookie, openSpace, "public-page");
    const sec = await createPage(a.cookie, privateSpace, "secret-source");

    // The secret page links TO the public page — a backlink exists pointing at public.
    const secPage = await getPage(a.cookie, sec.branchId);
    await saveContent(a.cookie, sec.branchId, linkTo(`/api/branches/${pub.branchId}/page`), secPage.updatedAt);

    // B can read the public page (open space) but not the secret source (private space).
    const pubPageAsB = await app.inject({ method: "GET", url: `/api/branches/${pub.branchId}/page`, headers: { cookie: b.cookie } });
    expect(pubPageAsB.statusCode).toBe(200);
    const body = pubPageAsB.json() as { backlinks: { sourceSlug: string }[] };
    // No leak: the secret source must not appear, even though it links to a page B can read.
    expect(body.backlinks).toHaveLength(0);

    // A (the owner) still sees it.
    const pubPageAsA = await app.inject({ method: "GET", url: `/api/branches/${pub.branchId}/page`, headers: { cookie: a.cookie } });
    const bodyA = pubPageAsA.json() as { backlinks: { sourceSlug: string }[] };
    expect(bodyA.backlinks.map((x) => x.sourceSlug)).toContain("secret-source");
  });

  it("404s the backlinks endpoint for a target page the caller cannot read", async () => {
    const a = await signup("audit-bl2-a@example.com");
    const b = await signup("audit-bl2-b@example.com");
    const privateSpace = await createSpace(a.cookie, "Locked");
    const page = await createPage(a.cookie, privateSpace, "hidden");

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${page.pageId}/backlinks`,
      headers: { cookie: b.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("favorites access enforcement", () => {
  it("rejects favoriting a branch the user cannot view", async () => {
    const a = await signup("audit-fav-a@example.com");
    const b = await signup("audit-fav-b@example.com");
    const privateSpace = await createSpace(a.cookie, "FavLocked");
    const page = await createPage(a.cookie, privateSpace, "hidden");

    const res = await app.inject({
      method: "POST",
      url: `/api/favorites/${page.branchId}`,
      headers: { cookie: b.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("drops favorites from the list once the branch is no longer accessible", async () => {
    const a = await signup("audit-fav2-a@example.com");
    const b = await signup("audit-fav2-b@example.com");
    const space = await createSpace(a.cookie, "FavSpace");

    // B becomes a viewer, favorites a page, then is removed — the favorite must vanish.
    const { getDb } = await import("../db/index.js");
    const { spaceMembers } = await import("../db/schema.js");
    await getDb().db.insert(spaceMembers).values({ spaceId: space, userId: b.userId, role: "viewer" });

    const page = await createPage(a.cookie, space, "public-page");
    const fav = await app.inject({
      method: "POST",
      url: `/api/favorites/${page.branchId}`,
      headers: { cookie: b.cookie },
    });
    expect(fav.statusCode).toBe(200);
    expect(fav.json().favorited).toBe(true);

    // A (admin) removes B from the space.
    await app.inject({
      method: "DELETE",
      url: `/api/spaces/${space}/members/${b.userId}`,
      headers: { cookie: a.cookie },
    });

    const list = await app.inject({ method: "GET", url: "/api/favorites", headers: { cookie: b.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(0);
  });
});

describe("spaces listing defaultRole grant", () => {
  it("lists a space whose defaultRole grants read to any authenticated user", async () => {
    const a = await signup("audit-space-a@example.com");
    const b = await signup("audit-space-b@example.com");
    const openSpace = await createSpace(a.cookie, "OpenByDefault");
    await app.inject({
      method: "PUT",
      url: `/api/spaces/${openSpace}/default-role`,
      headers: { cookie: a.cookie },
      payload: { defaultRole: "viewer" },
    });

    const list = await app.inject({ method: "GET", url: "/api/spaces", headers: { cookie: b.cookie } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).map((s) => s.id)).toContain(openSpace);
  });
});

describe("FK validation on structural writes", () => {
  it("404s cloning into a nonexistent target space", async () => {
    const a = await signup("audit-clone-a@example.com");
    const space = await createSpace(a.cookie, "Src");
    const page = await createPage(a.cookie, space, "p");

    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/clone`,
      headers: { cookie: a.cookie },
      payload: { targetSpaceId: crypto.randomUUID(), targetParentBranchId: null },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s adding a nonexistent user as space member", async () => {
    const a = await signup("audit-mem-a@example.com");
    const space = await createSpace(a.cookie, "Mem");
    const res = await app.inject({
      method: "POST",
      url: `/api/spaces/${space}/members`,
      headers: { cookie: a.cookie },
      payload: { userId: crypto.randomUUID(), role: "viewer" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s granting a space role to a nonexistent group", async () => {
    const a = await signup("audit-grp-a@example.com");
    const space = await createSpace(a.cookie, "Grp");
    const res = await app.inject({
      method: "POST",
      url: `/api/spaces/${space}/group-grants`,
      headers: { cookie: a.cookie },
      payload: { groupId: crypto.randomUUID(), role: "viewer" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("token suspension enforcement", () => {
  it("rejects bearer tokens whose creator is suspended", async () => {
    const d = await signup("audit-sus-a@example.com");

    const { createApiToken } = await import("../services/token.service.js");
    const { getDb } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");

    const { rawToken } = await createApiToken({
      createdBy: d.userId,
      isAdmin: false,
      scopeType: "account",
      scopeId: null,
      permission: "view",
      expiresAt: new Date(Date.now() + 60_000),
      name: "audit",
    });

    // Token works while the creator is active.
    const ok = await app.inject({
      method: "GET",
      url: "/api/spaces",
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(ok.statusCode).toBe(200);

    // Suspend the creator — the same token must now be refused.
    await getDb().db.update(users).set({ suspended: true }).where(eq(users.id, d.userId));

    const denied = await app.inject({
      method: "GET",
      url: "/api/spaces",
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(denied.statusCode).toBe(403);
  });
});
