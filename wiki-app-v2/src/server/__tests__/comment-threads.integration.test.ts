import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-48 — comment thread transactional integrity + per-page cap.
//
//   - create-thread used to do `thread-insert; comment-insert` as two
//     separate awaits. An interrupted request left an orphan thread with
//     no first comment. Asserts thread+first-comment land as one unit.
//   - per-page thread-count cap defaults to 1000, admin-tunable via
//     limits.commentThreadsPerPageMax (Confluence tier). A 409 is
//     returned when at the cap. The count + insert run in one tx so two
//     concurrent creates can't both observe "below cap" and both insert.
//   - delete-comment cascades used to do `delete; count-remaining;
//     maybe-delete-thread` as three separate awaits — a concurrent
//     reply racing the count could cause a stale thread-delete.
//     Verified end-to-end: thread survives until its last comment is gone.
//
// We follow the limits.integration.test.ts pattern: a single admin is
// signed up in beforeAll (slice-18 bootstrap auto-promotes the first
// user), and tests reuse that admin cookie. Subsequent signups would
// NOT be admin (only the first user is), so we don't sign more up.

const DB_PATH = `data/test-comment-threads-${randomBytes(4).toString("hex")}.db`;

process.env.DB_PATH = DB_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-cccccccccccccccc";
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

async function createPage(cookie: string, spaceId: string, slug: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug, parentBranchId: null },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

async function setThreadCap(cookie: string, value: unknown) {
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings/limits.commentThreadsPerPageMax",
    headers: { cookie },
    payload: { value },
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
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

describe("POST /api/branches/:branchId/comments (slice-48)", () => {
  let cookie: string;
  let branchId: string;

  beforeAll(async () => {
    // First signup → auto-promoted to admin by slice-18 hook.
    const { cookie: c } = await signup(`ct-admin-${randomBytes(3).toString("hex")}@example.com`);
    cookie = c;
    const sid = await createSpace(cookie, "C");
    const page = await createPage(cookie, sid, "main");
    branchId = page.branchId;
  });

  it("creates the thread AND its first comment atomically", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 5, body: "first message" },
    });
    expect(created.statusCode).toBe(201);
    const { threadId } = created.json();

    const { getDb } = await import("../db/index.js");
    const { commentThreads, comments } = await import("../db/schema.js");
    const db = getDb().db;

    const [thread] = await db.select().from(commentThreads).where(eq(commentThreads.id, threadId));
    expect(thread).toBeTruthy();

    const rows = await db.select().from(comments).where(eq(comments.threadId, threadId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("first message");
  });

  it("blocks the (cap+1)th thread with a 409 once the per-page cap is hit (admin-tunable)", async () => {
    // Cap = 3 means we can create three; the fourth attempt must 409.
    // Use a fresh page so previous tests' threads don't bleed into the count.
    await setThreadCap(cookie, 3);
    const freshSpace = await createSpace(cookie, `C${randomBytes(2).toString("hex")}`);
    const freshPage = await createPage(cookie, freshSpace, "fresh");
    const capBranchId = freshPage.branchId;

    const one = await app.inject({
      method: "POST", url: `/api/branches/${capBranchId}/comments`,
      headers: { cookie }, payload: { rangeFrom: 0, rangeTo: 1, body: "one" },
    });
    expect(one.statusCode).toBe(201);

    const two = await app.inject({
      method: "POST", url: `/api/branches/${capBranchId}/comments`,
      headers: { cookie }, payload: { rangeFrom: 2, rangeTo: 3, body: "two" },
    });
    expect(two.statusCode).toBe(201);

    const three = await app.inject({
      method: "POST", url: `/api/branches/${capBranchId}/comments`,
      headers: { cookie }, payload: { rangeFrom: 4, rangeTo: 5, body: "three" },
    });
    expect(three.statusCode).toBe(201);

    const four = await app.inject({
      method: "POST", url: `/api/branches/${capBranchId}/comments`,
      headers: { cookie }, payload: { rangeFrom: 6, rangeTo: 7, body: "four" },
    });
    expect(four.statusCode).toBe(409);
    expect(four.json().error).toMatch(/maximum/i);

    await setThreadCap(cookie, 1000);
  });

  it("falls back to the default cap when an admin stores a non-numeric value", async () => {
    // The PUT settings endpoint accepts any value (typed as `unknown`),
    // but the read path in comment.routes.ts clamps non-numeric /
    // out-of-range values back to THREADS_PER_PAGE_DEFAULT (1000). This
    // guard exists so an admin who fat-fingers "10000x" can't silently
    // lock everyone out of further comments.
    await setThreadCap(cookie, "garbage");

    const ok = await app.inject({
      method: "POST", url: `/api/branches/${branchId}/comments`,
      headers: { cookie }, payload: { rangeFrom: 6, rangeTo: 7, body: "after-clamp" },
    });
    expect(ok.statusCode).toBe(201);

    await setThreadCap(cookie, 1000);
  });

  it("rejects a reply past the per-thread reply cap with 409 (slice-51)", async () => {
    // Lower the reply cap to 1 (counts every comment on the thread,
    // including the opening one). With cap=1 the thread is full
    // immediately after creation, so the first reply must 409 with a
    // readable message. Restoring to 1000 at the end keeps later
    // tests on the documented default.
    const setCap = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentRepliesPerThreadMax",
      headers: { cookie },
      payload: { value: 1 },
    });
    expect(setCap.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 10, rangeTo: 11, body: "thread-opener" },
    });
    expect(created.statusCode).toBe(201);
    const { threadId } = created.json() as { threadId: string };

    const firstReply = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments/${threadId}`,
      headers: { cookie },
      payload: { body: "first reply" },
    });
    expect(firstReply.statusCode).toBe(409);
    expect(firstReply.payload).toContain("maximum number of replies (1)");

    const restore = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentRepliesPerThreadMax",
      headers: { cookie },
      payload: { value: 1000 },
    });
    expect(restore.statusCode).toBe(200);
  });
});

describe("DELETE /api/comments/:commentId (slice-48)", () => {
  let cookie: string;
  let branchId: string;

  beforeAll(async () => {
    // The slice-18 first-user auto-promotion is consumed by the previous
    // describe's sign-up, so we sign up a fresh user here. They're not
    // admin, but for thread-deletion tests we only need editor: owner or
    // anyone in a space they own can delete their own comments because
    // they created the space and have admin role on it.
    const { cookie: c } = await signup(`ct-del-${randomBytes(3).toString("hex")}@example.com`);
    cookie = c;
    const sid = await createSpace(cookie, "CD");
    const page = await createPage(cookie, sid, "del");
    branchId = page.branchId;
  });

  it("removes the containing thread only when its last comment is deleted", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/branches/${branchId}/comments`,
      headers: { cookie }, payload: { rangeFrom: 0, rangeTo: 1, body: "opening" },
    });
    const { threadId } = created.json();

    const reply = await app.inject({
      method: "POST", url: `/api/branches/${branchId}/comments/${threadId}`,
      headers: { cookie }, payload: { body: "reply" },
    });
    const replyId = reply.json().id as string;

    const { getDb } = await import("../db/index.js");
    const { comments, commentThreads } = await import("../db/schema.js");
    const db = getDb().db;

    // Delete the reply first — thread must remain (opening message still there).
    const delReply = await app.inject({
      method: "DELETE", url: `/api/comments/${replyId}`, headers: { cookie },
    });
    expect(delReply.statusCode).toBe(200);

    const [threadAfterReplyDel] = await db.select().from(commentThreads).where(eq(commentThreads.id, threadId));
    expect(threadAfterReplyDel).toBeTruthy();

    // Delete the opening comment — thread should now be cleaned up.
    const opening = await db.select().from(comments).where(and(eq(comments.threadId, threadId), eq(comments.body, "opening")));
    expect(opening).toHaveLength(1);
    const openingId = opening[0]!.id;

    const delOpening = await app.inject({
      method: "DELETE", url: `/api/comments/${openingId}`, headers: { cookie },
    });
    expect(delOpening.statusCode).toBe(200);

    const [threadGone] = await db.select().from(commentThreads).where(eq(commentThreads.id, threadId));
    expect(threadGone).toBeUndefined();
  });
});
