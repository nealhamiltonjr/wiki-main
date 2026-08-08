import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import { buildApp } from "../app.js";
import { getDb, closeDb } from "../db/index.js";
import { resetAuth } from "../auth/config.js";
import { users, identities, spaces, spaceMembers, pages, branches } from "../db/schema.js";

const TEST_SECRET = "test-pages-0123456789abcdef0123456789abcdef";
const DB_PATH = `data/test-pages-${randomBytes(4).toString("hex")}.db`;
const TEST_EMAIL = `pages-${randomBytes(4).toString("hex")}@test.local`;

let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let spaceId: string;
let rootBranchId: string;
let sessionCookie: string;

beforeAll(async () => {
  // Reset singletons from any previous test file. Vitest runs sequentially
  // (fileParallelism: false) so both the DB connection and the auth instance
  // may still hold stale references to the previous test file's DB.
  closeDb();
  resetAuth();

  // In case a previous run leaked this file (crash), clean it up first.
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}

  process.env.DB_PATH = DB_PATH;
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";

  app = await buildApp();
  const { db } = getDb();

  // Seed user + space + one root page (editor access).
  userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId, name: "Page Tester", email: TEST_EMAIL, emailVerified: true,
  });
  await db.insert(identities).values({
    id: crypto.randomUUID(), accountId: userId, providerId: "credential", userId,
    password: await hashPassword("TestPass-1234"),
  });

  spaceId = crypto.randomUUID();
  await db.insert(spaces).values({ id: spaceId, name: "Page Test Space", createdBy: userId });
  await db.insert(spaceMembers).values({ spaceId, userId, role: "admin" });

  const pageId = crypto.randomUUID();
  rootBranchId = crypto.randomUUID();
  await db.insert(pages).values({
    id: pageId, slug: "test-root", title: "Test Root", ownerId: userId,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world!" }] }] },
  });
  await db.insert(branches).values({
    id: rootBranchId, pageId, spaceId, createdBy: userId, parentBranchId: null, position: 0,
  });

  // Sign in to get a session cookie.
  const signInRes = await app.inject({
    method: "POST", url: "/api/auth/sign-in/email",
    payload: { email: TEST_EMAIL, password: "TestPass-1234" },
  });
  const raw = signInRes.headers["set-cookie"];
  sessionCookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
});

afterAll(async () => {
  await app.close();
  closeDb();
  resetAuth();
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}
});

describe("page routes", () => {
  it("GET /api/branches/:branchId/page returns page data", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`,
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeTypeOf("string");
    expect(body.slug).toBe("test-root");
    expect(body.title).toBe("Test Root");
    expect(body.content).toBeTruthy();
    expect(body.backlinks).toEqual([]);
    expect(body.attributes).toEqual([]);
    expect(body.placements).toHaveLength(1);
  });

  it("POST /api/spaces/:spaceId/pages creates a new page", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie: sessionCookie },
      payload: { slug: "new-page", title: "New Page", parentBranchId: rootBranchId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.branchId).toBeTypeOf("string");
    expect(body.pageId).toBeTypeOf("string");

    // Verify it appears under the parent.
    const pageRes = await app.inject({
      method: "GET", url: `/api/branches/${body.branchId}/page`,
      headers: { cookie: sessionCookie },
    });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.json().slug).toBe("new-page");
  });

  it("PUT saves content with OCC, returns updatedAt on success", async () => {
    // Load the page to get the current updatedAt.
    const load = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`,
      headers: { cookie: sessionCookie },
    });
    const { updatedAt } = load.json();

    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Updated content" }] }] };
    const saveRes = await app.inject({
      method: "PUT", url: `/api/branches/${rootBranchId}/page/content`,
      headers: { cookie: sessionCookie },
      payload: { content, expectedUpdatedAt: updatedAt },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.json().ok).toBe(true);

    // Re-read: content persisted.
    const reload = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`,
      headers: { cookie: sessionCookie },
    });
    const reloaded = reload.json();
    expect(reloaded.content.content[0].content[0].text).toBe("Updated content");
  });

  it("PUT with stale expectedUpdatedAt returns 409 conflict", async () => {
    const load = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`,
      headers: { cookie: sessionCookie },
    });
    const now = load.json().updatedAt;

    // First save succeeds (updates updatedAt).
    const first = await app.inject({
      method: "PUT", url: `/api/branches/${rootBranchId}/page/content`,
      headers: { cookie: sessionCookie },
      payload: { content: { type: "doc", content: [{ type: "paragraph" }] }, expectedUpdatedAt: now },
    });
    expect(first.statusCode).toBe(200);

    // Second save with the same stale timestamp → 409.
    const second = await app.inject({
      method: "PUT", url: `/api/branches/${rootBranchId}/page/content`,
      headers: { cookie: sessionCookie },
      payload: { content: { type: "doc", content: [{ type: "paragraph" }] }, expectedUpdatedAt: now },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("Conflict");
  });

  it("DELETE soft-deletes the last placement → page goes to trash", async () => {
    const res = await app.inject({
      method: "DELETE", url: `/api/branches/${rootBranchId}/page`,
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);

    // Page is now soft-deleted → GET returns 404.
    const get = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`,
      headers: { cookie: sessionCookie },
    });
    expect(get.statusCode).toBe(404);

    // Appears in trash listing.
    const trash = await app.inject({
      method: "GET", url: `/api/spaces/${spaceId}/trash`,
      headers: { cookie: sessionCookie },
    });
    expect(trash.statusCode).toBe(200);
    expect(trash.json()).toHaveLength(1);
  });

  it("POST restore revives the page, GET works again", async () => {
    const [trashEntry] = (await app.inject({
      method: "GET", url: `/api/spaces/${spaceId}/trash`,
      headers: { cookie: sessionCookie },
    })).json();

    const restore = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/trash/restore`,
      headers: { cookie: sessionCookie },
      payload: { pageId: trashEntry.pageId },
    });
    expect(restore.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET", url: `/api/branches/${rootBranchId}/page`,
      headers: { cookie: sessionCookie },
    });
    expect(get.statusCode).toBe(200);

    // Trash is empty again.
    const trash = await app.inject({
      method: "GET", url: `/api/spaces/${spaceId}/trash`,
      headers: { cookie: sessionCookie },
    });
    expect(trash.json()).toHaveLength(0);
  });

  it("POST purge permanently deletes the page", async () => {
    // Delete it again to put back in trash.
    await app.inject({
      method: "DELETE", url: `/api/branches/${rootBranchId}/page`,
      headers: { cookie: sessionCookie },
    });
    const [trashEntry] = (await app.inject({
      method: "GET", url: `/api/spaces/${spaceId}/trash`,
      headers: { cookie: sessionCookie },
    })).json();

    const purge = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/trash/purge`,
      headers: { cookie: sessionCookie },
      payload: { pageId: trashEntry.pageId },
    });
    expect(purge.statusCode).toBe(200);

    const trash = await app.inject({
      method: "GET", url: `/api/spaces/${spaceId}/trash`,
      headers: { cookie: sessionCookie },
    });
    expect(trash.json()).toHaveLength(0);

    // Page row is gone from the DB.
    const { db } = getDb();
    const [pageRow] = await db.select().from(pages).where(eq(pages.id, trashEntry.pageId));
    expect(pageRow).toBeUndefined();
  });
});
