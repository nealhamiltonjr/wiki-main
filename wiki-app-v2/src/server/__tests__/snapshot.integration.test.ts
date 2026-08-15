import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-snapshot-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-snapshot-repo-${randomBytes(4).toString("hex")}`;

process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;
let initGitRepo: typeof import("../services/git.service.js").initGitRepo;
let processPendingJobs: typeof import("../services/queue.service.js").processPendingJobs;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const cookie = raw?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^better-auth.session_token=/);
  return cookie;
}

async function signupAdmin(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: "Admin", email, password: "correct-horse-battery-staple" },
  });
  expect(res.statusCode).toBe(200);
  const userId = res.json().user?.id as string;
  const { getDb } = await import("../db/index.js");
  const { users } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  await getDb().db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));

  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: "correct-horse-battery-staple" },
  });
  expect(signIn.statusCode).toBe(200);
  return extractCookie(signIn.headers["set-cookie"]);
}

beforeAll(async () => {
  const root = process.cwd();
  if (!existsSync(`${root}/data`)) mkdirSync(`${root}/data`, { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, REPO_PATH]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  const { closeDb } = await import("../db/index.js");
  const { resetAuth } = await import("../auth/config.js");
  closeDb();
  resetAuth();
  ({ initGitRepo } = await import("../services/git.service.js"));
  ({ processPendingJobs } = await import("../services/queue.service.js"));
  await initGitRepo();

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
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, REPO_PATH]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe("DB snapshot + restore (slices B/C)", () => {
  it("manual snapshot enqueues a job and appears in snapshot history", async () => {
    const cookie = await signupAdmin("snap-admin@example.com");

    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Snap Space" } });
    expect(spaceRes.statusCode).toBe(201);
    const spaceId = spaceRes.json().id as string;
    await app.inject({ method: "POST", url: `/api/spaces/${spaceId}/pages`, headers: { cookie }, payload: { slug: "snap-page" } });
    await processPendingJobs(); // flush any git_commit

    const snap = await app.inject({
      method: "POST",
      url: "/api/git/snapshot",
      headers: { cookie },
      payload: { message: "my snapshot" },
    });
    expect(snap.statusCode).toBe(202);
    expect(snap.json().queued).toBe(true);

    await processPendingJobs(); // drain the git_db_snapshot job

    const list = await app.inject({ method: "GET", url: "/api/git/snapshots", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const snapshots = list.json() as { hash: string; message: string; date: string }[];
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.message).toContain("db-snapshot");
  });

  it("snapshot-status reflects settings and last snapshot", async () => {
    const cookie = await signupAdmin("snap-status@example.com");
    const res = await app.inject({ method: "GET", url: "/api/git/snapshot-status", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("enabled");
    expect(res.json()).toHaveProperty("intervalHours");
  });

  it("rejects non-admin snapshot access", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "Plain", email: "snap-plain@example.com", password: "correct-horse-battery-staple" },
    });
    expect(signup.statusCode).toBe(200);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "snap-plain@example.com", password: "correct-horse-battery-staple" },
    });
    const cookie = extractCookie(signIn.headers["set-cookie"]);

    const res = await app.inject({ method: "POST", url: "/api/git/snapshot", headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});
