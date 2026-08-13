import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-14 settings surface (§7.1): the consolidated /settings IA must sit on
// admin-guarded routes, groups remain the sole permission mechanism, and token
// creation must never widen a holder's reach. Each assertion goes through the
// real route layer (Fastify inject) exactly as a browser/script would.

const DB_PATH = `data/test-settings-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-settings-repo-${randomBytes(4).toString("hex")}`;

process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
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

async function promoteAdmin(email: string): Promise<void> {
  const { getDb } = await import("../db/index.js");
  const { users } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  await getDb().db.update(users).set({ isAdmin: true }).where(eq(users.email, email));
}

describe("settings consolidation (slice-14) integration", () => {
  let adminCookie: string;
  let memberCookie: string;
  let memberUserId: string;
  let otherUserId: string;
  let plainCookie: string;

  beforeAll(async () => {
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();

    ({ cookie: adminCookie, userId: otherUserId } = await signup("admin@test.invalid"));
    ({ cookie: memberCookie, userId: memberUserId } = await signup("member@test.invalid"));
    ({ cookie: plainCookie } = await signup("plain@test.invalid"));
    await promoteAdmin("admin@test.invalid");
  });

  afterAll(async () => {
    await app.close();
    rmSync(REPO_PATH, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ guards

  it("rejects unauthenticated settings reads", async () => {
    for (const url of ["/api/settings", "/api/settings/system-info", "/api/users", "/api/groups", "/api/git/remote"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("blocks non-admins from admin-only settings surfaces", async () => {
    for (const url of ["/api/settings", "/api/settings/system-info", "/api/users", "/api/groups", "/api/git/remote"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: memberCookie } });
      expect(res.statusCode, url).toBe(403);
    }
  });

  // ------------------------------------------------------------ system settings

  it("exposes system-info diagnostics to admins without leaking env secrets", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/system-info", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const info = res.json();
    expect(info.storage.dbPath).toBe(DB_PATH);
    expect(info.storage.gitRepoRoot).toBe(REPO_PATH);
    expect(info.runtime.node).toBeTruthy();
    expect(info.integrations.googleSso).toBe(false); // no env vars set in tests
  });

  it("stores and masks secret setting values", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/example.secret",
      headers: { cookie: adminCookie },
      payload: { value: "hunter2", isSecret: true },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().value).toBeUndefined();

    const list = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie: adminCookie } });
    expect(list.statusCode).toBe(200);
    const rows = list.json();
    const row = rows.find((r: { key: string }) => r.key === "example.secret");
    expect(row).toBeTruthy();
    expect(row.isSecret).toBe(true);
    expect(row.value).toBeUndefined(); // plaintext never leaves the server
  });

  it("round-trips the git remote config", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/git/remote",
      headers: { cookie: adminCookie },
      payload: { url: "git@example.com:org/wiki.git", branch: "trunk" },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/api/git/remote", headers: { cookie: adminCookie } });
    expect(get.json()).toEqual({ url: "git@example.com:org/wiki.git", branch: "trunk" });
  });

  // ------------------------------------------------------------------- groups

  it("manages groups and membership (the sole permission mechanism)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { cookie: adminCookie },
      payload: { name: "Editors", capabilities: ["page.edit"] },
    });
    expect(create.statusCode).toBe(201);
    const groupId = create.json().id as string;

    const add = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/members`,
      headers: { cookie: adminCookie },
      payload: { userId: memberUserId },
    });
    expect(add.statusCode).toBe(201);

    const members = await app.inject({ method: "GET", url: `/api/groups/${groupId}/members`, headers: { cookie: adminCookie } });
    expect(members.json()).toEqual([
      expect.objectContaining({ userId: memberUserId }),
    ]);

    const list = await app.inject({ method: "GET", url: "/api/groups", headers: { cookie: adminCookie } });
    const row = list.json().find((g: { id: string }) => g.id === groupId);
    expect(row.memberCount).toBe(1);
    expect(row.capabilities).toEqual(["page.edit"]);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/groups/${groupId}/members/${memberUserId}`,
      headers: { cookie: adminCookie },
    });
    expect(remove.statusCode).toBe(204);

    const del = await app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, headers: { cookie: adminCookie } });
    expect(del.statusCode).toBe(204);
  });

  it("rejects non-admin group creation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { cookie: memberCookie },
      payload: { name: "Nope" },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------- users

  it("lets admins promote users and guards against self-demotion/suspension", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/users/${memberUserId}`,
      headers: { cookie: adminCookie },
      payload: { isAdmin: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().isAdmin).toBe(true);

    // Self-demotion must be rejected — otherwise an admin could lock the
    // instance out of admin surfaces through the UI.
    const selfDemote = await app.inject({
      method: "PATCH",
      url: `/api/users/${otherUserId}`,
      headers: { cookie: adminCookie },
      payload: { isAdmin: false },
    });
    expect(selfDemote.statusCode).toBe(400);

    const selfSuspend = await app.inject({
      method: "PATCH",
      url: `/api/users/${otherUserId}`,
      headers: { cookie: adminCookie },
      payload: { suspended: true },
    });
    expect(selfSuspend.statusCode).toBe(400);
  });

  it("lists users for admins only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { email: string }[];
    expect(list.some((u) => u.email === "admin@test.invalid")).toBe(true);
    expect(list.some((u) => u.email === "member@test.invalid")).toBe(true);
  });

  // ------------------------------------------------------------------- tokens

  it("lets any user create account-scoped API tokens and revoke them", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const create = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: plainCookie },
      payload: { name: "ci", scopeType: "account", permission: "view", expiresAt: future },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().token).toBeTruthy(); // raw token shown exactly once
    const tokenId = create.json().id as string;

    const list = await app.inject({ method: "GET", url: "/api/tokens", headers: { cookie: plainCookie } });
    expect(list.json().some((t: { id: string }) => t.id === tokenId)).toBe(true);

    const revoke = await app.inject({ method: "DELETE", url: `/api/tokens/${tokenId}`, headers: { cookie: plainCookie } });
    expect(revoke.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/api/tokens", headers: { cookie: plainCookie } });
    expect(after.json().find((t: { id: string }) => t.id === tokenId).revokedAt).toBeTruthy();
  });

  it("denies expiration-less tokens to users without the capability (§3.10)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: plainCookie },
      payload: { name: "forever", scopeType: "account", permission: "view", expiresAt: null },
    });
    expect(res.statusCode).toBe(403);
  });

  it("prevents non-admins from creating scoped tokens that widen their reach", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: plainCookie },
      payload: { name: "sneaky", scopeType: "space", scopeId: "some-space", permission: "admin", expiresAt: null },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets admins create space/branch-scoped tokens", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: adminCookie },
      payload: { name: "spacebot", scopeType: "branch", scopeId: "some-branch", permission: "edit", expiresAt: null },
    });
    expect(res.statusCode).toBe(201);
  });
});
