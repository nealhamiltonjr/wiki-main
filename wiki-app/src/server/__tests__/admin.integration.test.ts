import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-admin.db";
const TEST_REPO_ROOT = "./data/test-admin-repo";
const TEST_FILES_ROOT = "./data/test-admin-files";

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

async function signupAndGetCookie(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery-staple", name: "Test" },
  });
  return { cookie: extractCookie(res.headers["set-cookie"]), userId: JSON.parse(res.body).user.id as string };
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

describe("group management - admin only", () => {
  it("a non-admin cannot create a group", async () => {
    const { cookie } = await signupAndGetCookie(app, "nonadmin@example.com");
    const res = await app.inject({ method: "POST", url: "/api/groups", headers: { cookie }, payload: { name: "HR" } });
    expect(res.statusCode).toBe(403);
  });

  it("an admin can create a group, add a member, and remove them", async () => {
    const { cookie, userId: adminId } = await signupAndGetCookie(app, "groupadmin@example.com");
    const { db } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));

    const { cookie: memberCookie, userId: memberId } = await signupAndGetCookie(app, "groupmember@example.com");

    const created = await app.inject({ method: "POST", url: "/api/groups", headers: { cookie }, payload: { name: "HR" } });
    expect(created.statusCode).toBe(201);
    const groupId = JSON.parse(created.body).id;

    const added = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/members`,
      headers: { cookie },
      payload: { userId: memberId },
    });
    expect(added.statusCode).toBe(204);

    const members = await app.inject({ method: "GET", url: `/api/groups/${groupId}/members`, headers: { cookie } });
    expect(JSON.parse(members.body).map((m: any) => m.userId)).toContain(memberId);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/groups/${groupId}/members/${memberId}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    const membersAfter = await app.inject({ method: "GET", url: `/api/groups/${groupId}/members`, headers: { cookie } });
    expect(JSON.parse(membersAfter.body).map((m: any) => m.userId)).not.toContain(memberId);
  });
});

describe("settings - admin only, secrets never leak", () => {
  it("a non-admin cannot read settings", async () => {
    const { cookie } = await signupAndGetCookie(app, "settingsnonadmin@example.com");
    const res = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("an admin can set and read a secret setting, and it's masked in the list response", async () => {
    const { cookie, userId } = await signupAndGetCookie(app, "settingsadmin@example.com");
    const { db } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));

    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/email.apiKey",
      headers: { cookie },
      payload: { value: "re_live_super_secret", isSecret: true },
    });
    expect(set.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
    const body = JSON.parse(list.body);
    const entry = body.find((s: any) => s.key === "email.apiKey");
    expect(entry.value).toBe("••••••••");
    expect(list.body).not.toContain("re_live_super_secret");
  });
});

describe("user deletion - reassign / delete-all / self-guard", () => {
  async function makeAdmin(cookie: string, userId: string) {
    const { db } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
  }

  async function createSpaceAndPage(cookie: string) {
    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "DelSpace" } });
    const spaceId = JSON.parse(space.body).id as string;
    const page = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "del-page", spaceId, parentBranchId: null },
    });
    return JSON.parse(page.body) as { pageId: string; branchId: string };
  }

  it("an admin cannot delete their own account", async () => {
    const { cookie, userId } = await signupAndGetCookie(app, "selfdelete@example.com");
    await makeAdmin(cookie, userId);
    const res = await app.inject({ method: "DELETE", url: `/api/admin/users/${userId}`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("reassign transfers owned pages to the target and deletes the user", async () => {
    const { cookie, userId } = await signupAndGetCookie(app, "reassign-admin@example.com");
    await makeAdmin(cookie, userId);
    const { cookie: victimCookie, userId: victimId } = await signupAndGetCookie(app, "reassign-victim@example.com");
    const { cookie: heirCookie, userId: heirId } = await signupAndGetCookie(app, "reassign-heir@example.com");

    const { pageId } = await createSpaceAndPage(victimCookie);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${victimId}`,
      headers: { cookie },
      payload: { reassignToId: heirId },
    });
    expect(res.statusCode).toBe(200);

    const { db } = await import("../db/index.js");
    const { pages, users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const [page] = await db.select({ ownerId: pages.ownerId }).from(pages).where(eq(pages.id, pageId));
    expect(page?.ownerId).toBe(heirId);
    const [gone] = await db.select().from(users).where(eq(users.id, victimId));
    expect(gone).toBeUndefined();
  });

  it("delete-all removes the user's pages and the user row", async () => {
    const { cookie, userId } = await signupAndGetCookie(app, "deleteall-admin@example.com");
    await makeAdmin(cookie, userId);
    const { cookie: victimCookie, userId: victimId } = await signupAndGetCookie(app, "deleteall-victim@example.com");

    const { pageId } = await createSpaceAndPage(victimCookie);

    const res = await app.inject({ method: "DELETE", url: `/api/admin/users/${victimId}`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(200);

    const { db } = await import("../db/index.js");
    const { pages, users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
    expect(page).toBeUndefined();
    const [gone] = await db.select().from(users).where(eq(users.id, victimId));
    expect(gone).toBeUndefined();
  });
});

describe("user export - admin only, valid zip", () => {
  it("returns a zip of the user's pages as markdown", async () => {
    const { cookie, userId } = await signupAndGetCookie(app, "export-admin@example.com");
    const { db } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));

    const { cookie: authorCookie, userId: authorId } = await signupAndGetCookie(app, "export-author@example.com");

    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie: authorCookie }, payload: { name: "ExportSpace" } });
    const spaceId = JSON.parse(space.body).id as string;
    await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie: authorCookie },
      payload: { slug: "exported-page", spaceId, parentBranchId: null },
    });

    const res = await app.inject({ method: "GET", url: `/api/admin/users/${authorId}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("PK\x03\x04");
  });

  it("returns 404 for a missing user", async () => {
    const { cookie, userId } = await signupAndGetCookie(app, "export-404-admin@example.com");
    const { db } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));

    const res = await app.inject({ method: "GET", url: "/api/admin/users/no-such-user/export", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe("session enrichment - capabilities travel with the session user", () => {
  it("get-session returns the user's group capabilities and groupIds", async () => {
    const { cookie: adminCookie, userId: adminId } = await signupAndGetCookie(app, "sess-admin@example.com");
    const { db } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));

    const groupRes = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { cookie: adminCookie },
      payload: { name: "Ops", capabilities: ["admin.*"] },
    });
    expect(groupRes.statusCode).toBe(201);
    const groupId = JSON.parse(groupRes.body).id as string;

    const { cookie: memberCookie, userId: memberId } = await signupAndGetCookie(app, "sess-member@example.com");
    const added = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/members`,
      headers: { cookie: adminCookie },
      payload: { userId: memberId },
    });
    expect(added.statusCode).toBe(204);

    const session = await app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie: memberCookie } });
    expect(session.statusCode).toBe(200);
    const body = JSON.parse(session.body);
    expect(body.user).toBeDefined();
    expect(body.user.capabilities).toContain("admin.*");
    expect(body.user.groupIds).toContain(groupId);
  });

  it("a plain user (no groups) gets empty capabilities", async () => {
    const { cookie } = await signupAndGetCookie(app, "sess-plain@example.com");
    const session = await app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie } });
    const body = JSON.parse(session.body);
    expect(body.user.capabilities).toEqual([]);
    expect(body.user.groupIds).toEqual([]);
  });
});
