import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

// Space-level permission management (§ space roles): the routes under
// /api/spaces/:spaceId (permissions read, members add/remove, group-grants
// add/remove, default-role) are space-admin-only, enforced by the shared
// spaceAdminGuard. This file gives those endpoints their own integration
// coverage (they previously had none - only branch permission routes were
// tested).

const TEST_DB_PATH = "./data/test-space-permissions.db";
const TEST_REPO_ROOT = "./data/test-space-permissions-repo";
const TEST_FILES_ROOT = "./data/test-space-permissions-files";

process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "test-only-key-do-not-use-in-real-deployment";

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

let adminCookie: string;
let ownerCookie: string; // space owner (auto space-admin)
let memberCookie: string; // plain member of the space
let outsiderCookie: string; // no role in the space
let spaceId: string;

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

  adminCookie = await signup("sp-perm-admin@example.com");
  ownerCookie = await signup("sp-perm-owner@example.com");
  memberCookie = await signup("sp-perm-member@example.com");
  outsiderCookie = await signup("sp-perm-outsider@example.com");

  const { users } = await import("../db/schema.js");
  await db.update(users).set({ isAdmin: true }).where(sql`email = 'sp-perm-admin@example.com'`).run();

  spaceId = await createSpace(ownerCookie, "Space Perm");

  // Add the plain member with a viewer role via the API under test.
  const { users: u } = await import("../db/schema.js");
  const [member] = await db.select({ id: u.id }).from(u).where(sql`email = 'sp-perm-member@example.com'`);
  const add = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/members`,
    headers: { cookie: ownerCookie },
    payload: { userId: member!.id, role: "viewer" },
  });
  expect(add.statusCode).toBe(201);
});

afterAll(async () => {
  await app.close();
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_REPO_ROOT, TEST_FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe("space permissions - admin-only surface", () => {
  it("a space member without admin role cannot read or write space permissions", async () => {
    const get = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: memberCookie } });
    expect(get.statusCode).toBe(403);

    const setRole = await app.inject({
      method: "PUT",
      url: `/api/spaces/${spaceId}/default-role`,
      headers: { cookie: memberCookie },
      payload: { defaultRole: "editor" },
    });
    expect(setRole.statusCode).toBe(403);
  });

  it("an outsider (no role at all) is denied at the access gate", async () => {
    const get = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: outsiderCookie } });
    expect(get.statusCode).toBe(403);
  });

  it("a global admin can manage any space's permissions", async () => {
    const get = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: adminCookie } });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body);
    expect(body.members).toBeDefined();
    expect(body.groups).toBeDefined();
  });
});

describe("space permissions - members", () => {
  it("owner can add a member, promote them, list them, and remove them", async () => {
    const { users } = await import("../db/schema.js");
    const [outsider] = await db.select({ id: users.id }).from(users).where(sql`email = 'sp-perm-outsider@example.com'`);

    const add = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/members`,
      headers: { cookie: ownerCookie },
      payload: { userId: outsider!.id, role: "viewer" },
    });
    expect(add.statusCode).toBe(201);

    const promote = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/members`,
      headers: { cookie: ownerCookie },
      payload: { userId: outsider!.id, role: "editor" },
    });
    expect(promote.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: ownerCookie } });
    const listed = JSON.parse(list.body).members as { userId: string; role: string }[];
    const row = listed.find((m) => m.userId === outsider!.id);
    expect(row?.role).toBe("editor");

    const del = await app.inject({ method: "DELETE", url: `/api/spaces/${spaceId}/members/${outsider!.id}`, headers: { cookie: ownerCookie } });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: ownerCookie } });
    expect(JSON.parse(after.body).members.map((m: any) => m.userId)).not.toContain(outsider!.id);
  });
});

describe("space permissions - group grants and default role", () => {
  it("adds and removes a group grant, and lists the group name", async () => {
    const groupRes = await app.inject({ method: "POST", url: "/api/groups", headers: { cookie: adminCookie }, payload: { name: "SPOps" } });
    const groupId = JSON.parse(groupRes.body).id as string;

    const grant = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/group-grants`,
      headers: { cookie: ownerCookie },
      payload: { groupId, role: "editor" },
    });
    expect(grant.statusCode).toBe(201);
    const grantId = JSON.parse(grant.body).ok ? (await (async () => {
      const list = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: ownerCookie } });
      return (JSON.parse(list.body).groupGrants as { id: string; groupId: string; groupName: string }[]).find((g) => g.groupId === groupId)!.id;
    })()) : "";

    const list = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: ownerCookie } });
    const grants = JSON.parse(list.body).groupGrants as { groupId: string; groupName: string }[];
    expect(grants.some((g) => g.groupId === groupId && g.groupName === "SPOps")).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/spaces/${spaceId}/group-grants/${grantId}`, headers: { cookie: ownerCookie } });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: ownerCookie } });
    expect(JSON.parse(after.body).groupGrants.map((g: any) => g.groupId)).not.toContain(groupId);
  });

  it("changes the space default role for new members", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/api/spaces/${spaceId}/default-role`,
      headers: { cookie: ownerCookie },
      payload: { defaultRole: "none" },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/permissions`, headers: { cookie: ownerCookie } });
    expect(JSON.parse(list.body).defaultRole).toBe("none");

    // Back to a sensible value so later reads of the space behave normally.
    await app.inject({
      method: "PUT",
      url: `/api/spaces/${spaceId}/default-role`,
      headers: { cookie: ownerCookie },
      payload: { defaultRole: "editor" },
    });
  });

  it("rejects invalid roles with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/spaces/${spaceId}/default-role`,
      headers: { cookie: ownerCookie },
      payload: { defaultRole: "superuser" },
    });
    expect(res.statusCode).toBe(400);
  });
});
