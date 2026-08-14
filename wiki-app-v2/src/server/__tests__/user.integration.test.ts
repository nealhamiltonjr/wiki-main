import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-user-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-user-repo-${randomBytes(4).toString("hex")}`;
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

async function signupAndLogin(email: string): Promise<{ cookie: string; userId: string }> {
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

/**
 * Promote a user to admin via raw SQL. Used because the test DB persists
 * across tests in this file and only the very first signed-up user is
 * auto-promoted to admin by the §11.6 bootstrap hook. Each test must
 * explicitly promote its actor (and any other admins it wants to test
 * against) before exercising admin-only routes.
 */
async function promoteAdmin(userId: string): Promise<void> {
  const { getDb } = await import("../db/index.js");
  const { sqlite } = getDb();
  sqlite.prepare("UPDATE user SET is_admin = 1, suspended = 0 WHERE id = ?").run(userId);
}

describe("user routes (brief §7.1) — slice-43 last-admin guard", () => {
  it("first signed-up user is admin", async () => {
    const owner = await signupAndLogin(`first-${randomBytes(3).toString("hex")}@test.local`);
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; isAdmin: boolean }>;
    const me = list.find((u) => u.id === owner.userId);
    expect(me?.isAdmin).toBe(true);
  });

  it("blocks an admin from demoting themselves (self-lockout, 400)", async () => {
    const owner = await signupAndLogin(`selfdemote-${randomBytes(3).toString("hex")}@test.local`);
    await promoteAdmin(owner.userId);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${owner.userId}`,
      headers: { cookie: owner.cookie },
      payload: { isAdmin: false },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/cannot remove your own admin/i);
  });

  it("blocks an admin from suspending themselves (self-lockout, 400)", async () => {
    const owner = await signupAndLogin(`selfsusp-${randomBytes(3).toString("hex")}@test.local`);
    await promoteAdmin(owner.userId);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${owner.userId}`,
      headers: { cookie: owner.cookie },
      payload: { suspended: true },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/cannot suspend your own account/i);
  });



  it("does NOT false-positive 409 on a suspended-target demote", async () => {
    // Demoting a SUSPENDED admin does not change the active-admin count
    // (the target wasn't active). The guard must not reject this benign
    // action — see the willRemoveActiveAdmin comment in user.routes.ts.
    const other = await signupAndLogin(`suspTgtB-${randomBytes(3).toString("hex")}@test.local`);
    const actor = await signupAndLogin(`suspTgtC-${randomBytes(3).toString("hex")}@test.local`);
    const { getDb } = await import("../db/index.js");
    const { sqlite } = getDb();
    await promoteAdmin(other.userId);
    await promoteAdmin(actor.userId);
    // Make `other` admin but suspended; actor remains the sole ACTIVE admin.
    sqlite.prepare("UPDATE user SET suspended = 1 WHERE id = ?").run(other.userId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${other.userId}`,
      headers: { cookie: actor.cookie },
      payload: { isAdmin: false },
    });
    expect(res.statusCode).toBe(200);

    const row = sqlite
      .prepare("SELECT is_admin FROM user WHERE id = ?")
      .get(other.userId) as { is_admin: number | boolean } | undefined;
    expect(Number(row?.is_admin ?? 1)).toBe(0);
  });

  it("allows demoting when another active admin exists", async () => {
    const owner = await signupAndLogin(`safeadmA-${randomBytes(3).toString("hex")}@test.local`);
    const other = await signupAndLogin(`safeadmB-${randomBytes(3).toString("hex")}@test.local`);
    const third = await signupAndLogin(`safeadmC-${randomBytes(3).toString("hex")}@test.local`);
    await promoteAdmin(owner.userId);
    await promoteAdmin(other.userId);
    await promoteAdmin(third.userId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${other.userId}`,
      headers: { cookie: owner.cookie },
      payload: { isAdmin: false },
    });
    expect(res.statusCode).toBe(200);

    const { getDb } = await import("../db/index.js");
    const { sqlite } = getDb();
    const row = sqlite
      .prepare("SELECT is_admin FROM user WHERE id = ?")
      .get(other.userId) as { is_admin: number | boolean } | undefined;
    expect(Number(row?.is_admin ?? 1)).toBe(0);
  });

  it("two concurrent PATCHes racing to demote each other leave ≥1 active admin", async () => {
    // Slice-43 regression: the race. A and B are both admins. A starts
    // demoting B, B starts demoting A. The invariant we MUST hold: never
    // end with zero active admins.
    //
    // How the system actually prevents lockout depends on how Node's
    // event loop interleaves the two requests:
    //   - If both access checks read the user table before either commit
    //     lands, both reach the route and the BEGIN IMMEDIATE transaction
    //     serializes them; the second writer's count check sees count=1
    //     and aborts with 409. (This is the path the inner guard
    //     defends.)
    //   - If A's full transaction commits before B's access check runs
    //     (also common — better-sqlite3 is sync and the route body runs
    //     inside the same microtask), B's middleware reads B as
    //     non-admin and replies 403. (This is also a correct defense —
    //     the access middleware itself blocks the second writer.)
    //
    // Either way, after the race resolves, at least one active admin
    // must remain. The test asserts that invariant directly rather than
    // pinning a specific status code.
    const owner = await signupAndLogin(`raceA-${randomBytes(3).toString("hex")}@test.local`);
    const other = await signupAndLogin(`raceB-${randomBytes(3).toString("hex")}@test.local`);
    await promoteAdmin(owner.userId);
    await promoteAdmin(other.userId);

    const [a, b] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/users/${other.userId}`,
        headers: { cookie: owner.cookie },
        payload: { isAdmin: false },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/users/${owner.userId}`,
        headers: { cookie: other.cookie },
        payload: { isAdmin: false },
      }),
    ]);

    const codes = [a.statusCode, b.statusCode];
    // Either both succeed (200/200) — possible if the access middleware
    // serialized them and one win followed by the other's 403 — OR one
    // is rejected by the inner guard (409). Both writes succeeding with
    // 200 is the unsafe case to avoid. We accept [200,403], [200,409],
    // or [409,403], but never [200,200].
    if (codes.every((c) => c === 200)) {
      throw new Error(
        `Race resolved without any guard firing (codes=${codes.join(",")}); system may be unsafe`,
      );
    }

    const { getDb } = await import("../db/index.js");
    const { sqlite } = getDb();
    const rows = sqlite
      .prepare("SELECT COUNT(*) AS n FROM user WHERE is_admin = 1 AND suspended = 0")
      .all() as { n: number }[];
    const n = rows[0]?.n ?? 0;
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
