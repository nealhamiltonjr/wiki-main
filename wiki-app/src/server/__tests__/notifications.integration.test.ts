import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-notifications.db";
const TEST_REPO_ROOT = "./data/test-notifications-repo";
const TEST_FILES_ROOT = "./data/test-notifications-files";

process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "test-only-key-do-not-use-in-real-deployment";

let app: FastifyInstance;

function extractCookie(h: string | string[] | undefined): string {
  const raw = Array.isArray(h) ? h[0] : h;
  return raw?.split(";")[0] ?? "";
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

describe("notifications", () => {
  it("returns empty list for new user", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "n1@example.com", password: "password-123456789", name: "N1" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);

    const res = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toEqual([]);
    expect(JSON.parse(res.body).unread).toBe(0);
  });

  it("delivers mention notifications after page save", async () => {
    // Register two users
    const u1 = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "alice@example.com", password: "password-123456789", name: "Alice" },
    });
    const c1 = extractCookie(u1.headers["set-cookie"]);
    const u1Id = JSON.parse(u1.body)?.user?.id ?? "";

    const u2 = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "bob@example.com", password: "password-123456789", name: "Bob" },
    });
    const c2 = extractCookie(u2.headers["set-cookie"]);
    const u2Id = JSON.parse(u2.body)?.user?.id ?? "";

    expect(u1Id).toBeTruthy();
    expect(u2Id).toBeTruthy();
    expect(u1Id).not.toBe(u2Id);

    // Bob creates a space and page
    const space = await app.inject({
      method: "POST",
      url: "/api/spaces",
      headers: { cookie: c2 },
      payload: { name: "Mention Space" },
    });
    const spaceId = JSON.parse(space.body).id;

    const pageRes = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie: c2 },
      payload: { slug: "mention-test", spaceId, parentBranchId: null },
    });
    const { branchId, pageId } = JSON.parse(pageRes.body);

    // Query the DB directly for the current updatedAt (OCC requirement)
    const { db } = await import("../db/index.js");
    const { pages } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select({ updatedAt: pages.updatedAt }).from(pages).where(eq(pages.id, pageId));

    // Bob saves content that @mentions Alice
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Mention Test" }] },
        { type: "paragraph", content: [
          { type: "text", text: "Hey " },
          { type: "text", text: "@Alice", marks: [{ type: "mention", attrs: { type: "user", id: u1Id } }] },
          { type: "text", text: " check this out!" },
        ]},
      ],
    };

    const saveRes = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageId}/branches/${branchId}`,
      headers: { cookie: c2 },
      payload: { content, expectedUpdatedAt: row!.updatedAt },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(JSON.parse(saveRes.body).ok).toBe(true);

    // Verify Alice got a notification (processMentions is fire-and-forget, retry if needed)
    let items: any[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: c1 } });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      items = body.items;
      if (items.length >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].kind).toBe("mention");
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: c1 } })).body).unread).toBeGreaterThanOrEqual(1);
  });

  it("marks a notification as read", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "n2@example.com", password: "password-123456789", name: "N2" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);

    // Manually create a notification via the API or service
    // We'll test mark-read via the existing endpoint by first getting notifications
    // Use the internal service to seed one
    const { createNotification } = await import("../services/notification.service.js");
    const nid = await createNotification(JSON.parse(signup.body)?.user?.id ?? "", "system", { body: "Test" });

    const res = await app.inject({
      method: "PUT",
      url: `/api/notifications/${nid}/read`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    // Verify it's now read (unread count = 0)
    const count = await app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie } });
    expect(JSON.parse(count.body).unread).toBe(0);
  });

  it("marks all notifications as read", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "n3@example.com", password: "password-123456789", name: "N3" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);
    const userId = JSON.parse(signup.body)?.user?.id ?? "";

    const { createNotification } = await import("../services/notification.service.js");
    await createNotification(userId, "system", { body: "A" });
    await createNotification(userId, "system", { body: "B" });

    const res = await app.inject({
      method: "PUT",
      url: "/api/notifications/read-all",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const count = await app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie } });
    expect(JSON.parse(count.body).unread).toBe(0);
  });
});

describe("mention extraction", () => {
  it("extracts user mention IDs from Tiptap JSON", async () => {
    const { extractMentions } = await import("../services/mention.service.js");
    const content = {
      type: "doc",
      content: [
        { type: "paragraph", content: [
          { type: "text", text: "@Alice", marks: [{ type: "mention", attrs: { type: "user", id: "user-1" } }] },
        ]},
      ],
    };
    expect(extractMentions(content)).toEqual(["user-1"]);
  });

  it("returns empty for content without mentions", async () => {
    const { extractMentions } = await import("../services/mention.service.js");
    expect(extractMentions({ type: "doc", content: [{ type: "paragraph" }] })).toEqual([]);
    expect(extractMentions(null)).toEqual([]);
    expect(extractMentions(undefined)).toEqual([]);
  });

  it("deduplicates repeated mentions", async () => {
    const { extractMentions } = await import("../services/mention.service.js");
    const content = {
      type: "doc",
      content: [
        { type: "paragraph", content: [
          { type: "text", text: "@A", marks: [{ type: "mention", attrs: { type: "user", id: "u1" } }] },
          { type: "text", text: " and @A again ", marks: [{ type: "mention", attrs: { type: "user", id: "u1" } }] },
        ]},
      ],
    };
    expect(extractMentions(content)).toEqual(["u1"]);
  });
});

describe("user search API", () => {
  it("returns other users when searching", async () => {
    // Register two users
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "alpha@example.com", password: "password-123456789", name: "Alpha" },
    });
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "beta@example.com", password: "password-123456789", name: "Beta" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);

    const res = await app.inject({
      method: "GET",
      url: "/api/users/search?q=alpha",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { users: results } = JSON.parse(res.body);
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("Alpha");
    expect(results[0].email).toBe("alpha@example.com");
  });

  it("excludes the caller from results", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "gamma@example.com", password: "password-123456789", name: "Gamma" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);

    const res = await app.inject({
      method: "GET",
      url: "/api/users/search?q=gamma",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { users: results } = JSON.parse(res.body);
    expect(results.length).toBe(0);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users/search?q=test" });
    expect(res.statusCode).toBe(401);
  });
});
