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
