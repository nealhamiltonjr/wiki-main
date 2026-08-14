import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-9 gate (brief §9): comments, backlinks, favorites, notifications.
// Core quality parity with the old app — regression coverage per feature.
// Env vars MUST be set before the app module is imported.
const DB_PATH = `data/test-slice9-${randomBytes(4).toString("hex")}.db`;

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

async function savePage(cookie: string, branchId: string, content: unknown) {
  const current = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
  const { updatedAt } = current.json();
  const res = await app.inject({
    method: "PUT",
    url: `/api/branches/${branchId}/page/content`,
    headers: { cookie },
    payload: { content, expectedUpdatedAt: updatedAt },
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

describe("backlinks (§7.12)", () => {
  it("extracts and stores backlinks on page save", async () => {
    const { cookie } = await signup(`bl-a-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "BL");
    const a = await createPage(cookie, spaceId, "page-a");
    const b = await createPage(cookie, spaceId, "page-b");

    await savePage(cookie, a.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "go to B", marks: [{ type: "link", attrs: { href: `/api/branches/${b.branchId}/page` } }] }] }],
    });

    const res = await app.inject({ method: "GET", url: `/api/pages/${b.pageId}/backlinks`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json().backlinks as { sourceSlug: string; sourceBranchId: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.sourceSlug).toBe("page-a");
    expect(list[0]!.sourceBranchId).toBeTruthy();
  });

  it("removes stale backlinks on re-save", async () => {
    const { cookie } = await signup(`bl-b-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "BL2");
    const a = await createPage(cookie, spaceId, "a");
    const b = await createPage(cookie, spaceId, "b");
    const c = await createPage(cookie, spaceId, "c");

    await savePage(cookie, a.branchId, {
      type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: `/api/branches/${b.branchId}/page` } }] }] }],
    });
    const bl1 = await app.inject({ method: "GET", url: `/api/pages/${b.pageId}/backlinks`, headers: { cookie } });
    expect(bl1.json().backlinks).toHaveLength(1);

    // A now links to C instead — B's backlink must disappear.
    await savePage(cookie, a.branchId, {
      type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: `/api/branches/${c.branchId}/page` } }] }] }],
    });
    const bl2 = await app.inject({ method: "GET", url: `/api/pages/${b.pageId}/backlinks`, headers: { cookie } });
    expect(bl2.json().backlinks).toHaveLength(0);
    const bl3 = await app.inject({ method: "GET", url: `/api/pages/${c.pageId}/backlinks`, headers: { cookie } });
    expect(bl3.json().backlinks).toHaveLength(1);
  });

  it("detects block-level links", async () => {
    const { cookie } = await signup(`bl-c-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "BL3");
    const a = await createPage(cookie, spaceId, "a");
    const b = await createPage(cookie, spaceId, "b");

    await savePage(cookie, a.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "ref", marks: [{ type: "link", attrs: { href: `/api/branches/${b.branchId}/page#block-X1` } }] }] }],
    });

    const res = await app.inject({ method: "GET", url: `/api/pages/${b.pageId}/backlinks`, headers: { cookie } });
    const list = res.json().backlinks as { targetBlockId: string | null }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.targetBlockId).toBe("block-X1");
  });
});

describe("comments (§9)", () => {
  it("creates a thread, lists it, and replies", async () => {
    const { cookie } = await signup(`cm-a-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "CM");
    const page = await createPage(cookie, spaceId, "p");

    const create = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, blockId: "b1", selection: "hello", body: "first note" },
    });
    expect(create.statusCode).toBe(201);
    const { threadId } = create.json();

    const list = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/comments`, headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const threads = list.json();
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(threadId);
    expect(threads[0].blockId).toBe("b1");
    expect(threads[0].selection).toBe("hello");
    expect(threads[0].authorName).toBeTruthy();
    expect(threads[0].comments).toHaveLength(1);
    expect(threads[0].comments[0].body).toBe("first note");

    const reply = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/comments/${threadId}`,
      headers: { cookie },
      payload: { body: "reply note" },
    });
    expect(reply.statusCode).toBe(201);

    const list2 = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/comments`, headers: { cookie } });
    expect(list2.json()[0].comments).toHaveLength(2);
  });

  it("edits and deletes own comments; deleting the last comment removes the thread", async () => {
    const { cookie } = await signup(`cm-b-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "CM2");
    const page = await createPage(cookie, spaceId, "p");

    const create = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 1, rangeTo: 3, body: "original" },
    });
    const { threadId } = create.json();

    const reply = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/comments/${threadId}`,
      headers: { cookie },
      payload: { body: "reply" },
    });
    const { id: replyId } = reply.json();

    // Edit the reply.
    const edit = await app.inject({
      method: "PUT",
      url: `/api/comments/${replyId}`,
      headers: { cookie },
      payload: { body: "edited" },
    });
    expect(edit.statusCode).toBe(200);

    // Delete the first comment; thread must still exist (one comment left).
    const firstCommentId = (await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/comments`, headers: { cookie } })).json()[0].comments[0].id;
    const del = await app.inject({ method: "DELETE", url: `/api/comments/${firstCommentId}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);

    // Delete the last comment → thread disappears too.
    const last = (await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/comments`, headers: { cookie } })).json();
    expect(last).toHaveLength(1);
    await app.inject({ method: "DELETE", url: `/api/comments/${last[0].comments[0].id}`, headers: { cookie } });
    const gone = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/comments`, headers: { cookie } });
    expect(gone.json()).toHaveLength(0);
  });

  it("cannot edit someone else's comment", async () => {
    const a = await signup(`cm-c-${randomBytes(4).toString("hex")}@example.com`);
    const b = await signup(`cm-c2-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(a.cookie, "CM3");
    const page = await createPage(a.cookie, spaceId, "p");

    await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/comments`,
      headers: { cookie: a.cookie },
      payload: { rangeFrom: 0, rangeTo: 1, body: "mine" },
    });
    const list = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/comments`, headers: { cookie: a.cookie } });
    const commentId = list.json()[0]!.comments[0]!.id;

    const edit = await app.inject({
      method: "PUT",
      url: `/api/comments/${commentId}`,
      headers: { cookie: b.cookie },
      payload: { body: "hijacked" },
    });
    expect(edit.statusCode).toBe(403);
  });

  it("toggles thread resolution", async () => {
    const { cookie } = await signup(`cm-d-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "CM4");
    const page = await createPage(cookie, spaceId, "p");

    const create = await app.inject({
      method: "POST",
      url: `/api/branches/${page.branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 2, body: "note" },
    });
    const { threadId } = create.json();

    const resolve = await app.inject({ method: "PUT", url: `/api/comment-threads/${threadId}/resolve`, headers: { cookie } });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().resolved).toBe(true);

    const list = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/comments`, headers: { cookie } });
    expect(list.json()[0].resolvedAt).toBeTruthy();

    const unresolve = await app.inject({ method: "PUT", url: `/api/comment-threads/${threadId}/resolve`, headers: { cookie } });
    expect(unresolve.json().resolved).toBe(false);
  });
});

describe("favorites (§9)", () => {
  it("toggles a favorite and lists it with page info", async () => {
    const { cookie } = await signup(`fav-a-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "FAV");
    const page = await createPage(cookie, spaceId, "starred");

    const on = await app.inject({ method: "POST", url: `/api/favorites/${page.branchId}`, headers: { cookie } });
    expect(on.statusCode).toBe(200);
    expect(on.json().favorited).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/favorites", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const rows = list.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].branchId).toBe(page.branchId);
    expect(rows[0].slug).toBe("starred");

    const off = await app.inject({ method: "POST", url: `/api/favorites/${page.branchId}`, headers: { cookie } });
    expect(off.json().favorited).toBe(false);
    const list2 = await app.inject({ method: "GET", url: "/api/favorites", headers: { cookie } });
    expect(list2.json()).toHaveLength(0);
  });

  it("favorites are per-user", async () => {
    const a = await signup(`fav-b-${randomBytes(4).toString("hex")}@example.com`);
    const b = await signup(`fav-b2-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(a.cookie, "FAV2");
    const page = await createPage(a.cookie, spaceId, "p");

    await app.inject({ method: "POST", url: `/api/favorites/${page.branchId}`, headers: { cookie: a.cookie } });
    const bList = await app.inject({ method: "GET", url: "/api/favorites", headers: { cookie: b.cookie } });
    expect(bList.json()).toHaveLength(0);
  });
});

describe("notifications (§9)", () => {
  it("returns an empty list for a new user", async () => {
    const { cookie } = await signup(`nt-a-${randomBytes(4).toString("hex")}@example.com`);
    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    expect(res.json().unread).toBe(0);
  });

  it("delivers mention notifications after a save (MARK shape)", async () => {
    const u1 = await signup(`nt-mark-${randomBytes(4).toString("hex")}@example.com`);
    const u2 = await signup(`nt-mark2-${randomBytes(4).toString("hex")}@example.com`);

    const spaceId = await createSpace(u2.cookie, "Mention Space");
    // Slice-55: mentions only deliver to users in the same space as the page,
    // so add u1 as a member before the save (matches the production flow —
    // @-mention suggestions are drawn from space members).
    const addRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/members`,
      headers: { cookie: u2.cookie },
      payload: { userId: u1.userId, role: "editor" },
    });
    expect(addRes.statusCode).toBe(201);

    const page = await createPage(u2.cookie, spaceId, "mention-test");

    await savePage(u2.cookie, page.branchId, {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Mention Test" }] },
        { type: "paragraph", content: [
          { type: "text", text: "Hey " },
          { type: "text", text: "@Alice", marks: [{ type: "mention", attrs: { type: "user", id: u1.userId } }] },
          { type: "text", text: " check this out!" },
        ]},
      ],
    });

    // processMentions is fire-and-forget; poll briefly.
    let items: { kind: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: u1.cookie } });
      items = res.json().items;
      if (items.length >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.kind).toBe("mention");
  });

  it("delivers mention notifications for mention NODES (client format)", async () => {
    const u1 = await signup(`nt-node-${randomBytes(4).toString("hex")}@example.com`);
    const u2 = await signup(`nt-node2-${randomBytes(4).toString("hex")}@example.com`);

    const spaceId = await createSpace(u2.cookie, "Mention Node Space");
    // Slice-55: see the per-space membership gate in the MARK-shape test above.
    const addRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/members`,
      headers: { cookie: u2.cookie },
      payload: { userId: u1.userId, role: "editor" },
    });
    expect(addRes.statusCode).toBe(201);

    const page = await createPage(u2.cookie, spaceId, "mention-node-test");

    await savePage(u2.cookie, page.branchId, {
      type: "doc",
      content: [
        { type: "paragraph", content: [
          { type: "mention", attrs: { id: u1.userId, label: "Mentor", mentionSuggestionChar: "@" } },
          { type: "text", text: " please review" },
        ]},
      ],
    });

    let items: { kind: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: u1.cookie } });
      items = res.json().items;
      if (items.length >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.kind).toBe("mention");
  });

  it("does not notify yourself", async () => {
    const { cookie, userId } = await signup(`nt-self-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "Self Space");
    const page = await createPage(cookie, spaceId, "self");

    await savePage(cookie, page.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label: "Me" } }] }],
    });

    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie } });
    expect(res.json().items).toHaveLength(0);
  });

  it("marks single and all notifications as read", async () => {
    const { cookie, userId } = await signup(`nt-read-${randomBytes(4).toString("hex")}@example.com`);
    // Create two notifications directly via the service.
    const { createNotification } = await import("../services/notification.service.js");
    const n1 = await createNotification(userId, "system", { body: "one" });
    const n2 = await createNotification(userId, "system", { body: "two" });

    const unread = await app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie } });
    expect(unread.json().unread).toBe(2);

    const markOne = await app.inject({ method: "PUT", url: `/api/notifications/${n1}/read`, headers: { cookie } });
    expect(markOne.statusCode).toBe(200);
    const unread2 = await app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie } });
    expect(unread2.json().unread).toBe(1);

    const markAll = await app.inject({ method: "PUT", url: "/api/notifications/read-all", headers: { cookie } });
    expect(markAll.statusCode).toBe(200);
    const unread3 = await app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie } });
    expect(unread3.json().unread).toBe(0);
    void n2;
  });

  it("marks read are scoped to the notification owner", async () => {
    const a = await signup(`nt-own-${randomBytes(4).toString("hex")}@example.com`);
    const b = await signup(`nt-own2-${randomBytes(4).toString("hex")}@example.com`);
    const { createNotification } = await import("../services/notification.service.js");
    const nid = await createNotification(a.userId, "system", { body: "x" });

    // B tries to mark A's notification read — must not affect it.
    await app.inject({ method: "PUT", url: `/api/notifications/${nid}/read`, headers: { cookie: b.cookie } });
    const aUnread = await app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie: a.cookie } });
    expect(aUnread.json().unread).toBe(1);
  });
});
