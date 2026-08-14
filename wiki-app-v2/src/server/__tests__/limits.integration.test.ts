import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-44: admin-tunable size caps on comments (default 32 KB) and
// plugin uploads (default 50 MB). Each test stands up a fresh app +
// ephemeral DB so settings don't leak between tests.

function freshDbPath(tag: string): string {
  const id = randomBytes(4).toString("hex");
  const db = `data/test-limits-${tag}-${id}.db`;
  const repo = `data/test-limits-repo-${tag}-${id}`;
  process.env.DB_PATH = db;
  process.env.GIT_REPO_ROOT = repo;
  process.env.PLUGIN_ROOT = `data/test-limits-plugins-${tag}-${id}`;
  process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
    "/sign-up/*": false,
    "/sign-in/*": false,
  });
  return `${db}|${repo}|${process.env.PLUGIN_ROOT}`;
}

function cleanup(paths: string) {
  for (const p of paths.split("|")) {
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return raw?.split(";")[0] ?? "";
}

async function signup(app: FastifyInstance, email: string): Promise<{ cookie: string; userId: string }> {
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

async function createSpace(app: FastifyInstance, cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createPage(app: FastifyInstance, cookie: string, spaceId: string, slug: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

// ===========================================================================
// Comment cap
// ===========================================================================

describe("slice-44: comment body cap", () => {
  let app: FastifyInstance;
  let paths: string;
  let cookie: string;
  let branchId: string;

  beforeAll(async () => {
    paths = freshDbPath("cm");
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();
    // The first signup in the process becomes admin via the bootstrap
    // hook. Subsequent signups (e.g. in the plugin describe below) do
    // not, so it's important this describe's signup runs first.
    const { cookie: c } = await signup(app, `limits-admin-${randomBytes(3).toString("hex")}@test.local`);
    cookie = c;
    const spaceId = await createSpace(app, cookie, "limits");
    const page = await createPage(app, cookie, spaceId, "p");
    branchId = page.branchId;
  });

  afterAll(async () => {
    await app.close();
    cleanup(paths);
  });

  it("rejects an over-cap body on thread creation with 400", async () => {
    const tooBig = "x".repeat(32769); // default cap = 32768
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: tooBig },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/exceeds the configured limit \(32768 characters\)/);
  });

  it("accepts a body exactly at the cap on thread creation", async () => {
    const atCap = "y".repeat(32768);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: atCap },
    });
    expect(res.statusCode).toBe(201);
  });

  it("accepts a normal small body on thread creation", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: "tiny" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects over-cap body on reply", async () => {
    const tiny = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: "seed" },
    });
    const threadId = tiny.json().threadId as string;
    const tooBig = "z".repeat(32769);
    const reply = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments/${threadId}`,
      headers: { cookie },
      payload: { body: tooBig },
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: string }).error).toMatch(/exceeds the configured limit \(32768 characters\)/);
  });

  it("rejects over-cap body on edit", async () => {
    const tiny = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: "edit seed" },
    });
    expect(tiny.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
    });
    const threads = list.json() as Array<{ comments: Array<{ id: string; body: string }> }>;
    const target = threads
      .map((t) => t.comments.find((c) => c.body === "edit seed"))
      .find((c): c is { id: string; body: string } => c !== undefined);
    expect(target).toBeDefined();
    const tooBig = "w".repeat(32769);
    const edit = await app.inject({
      method: "PUT",
      url: `/api/comments/${target!.id}`,
      headers: { cookie },
      payload: { body: tooBig },
    });
    expect(edit.statusCode).toBe(400);
  });

  it("falls back to default when admin sets a bogus cap (string)", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentBodyMaxBytes",
      headers: { cookie },
      payload: { value: "not a number" },
    });
    expect(set.statusCode).toBe(200);
    // The cap is type-validated at read time inside the route, so an
    // invalid stored value falls back to the default 32768.
    const tooBig = "q".repeat(32769);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: tooBig },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/32768 characters/);
  });

  it("lets the admin lower the cap and rejects the new oversize", async () => {
    // Pick a cap that's above the route's lower clamp (1024 chars) so
    // the route honors it; the clamp exists to prevent admins from
    // accidentally locking the system to e.g. 0-character comments.
    const NEW_CAP = 2048;
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentBodyMaxBytes",
      headers: { cookie },
      payload: { value: NEW_CAP },
    });
    expect(set.statusCode).toBe(200);

    const tooBig = "r".repeat(NEW_CAP + 1);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: tooBig },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(
      new RegExp(`exceeds the configured limit \\(${NEW_CAP} characters\\)`),
    );

    // Exactly at the new cap still works.
    const ok = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: "s".repeat(NEW_CAP) },
    });
    expect(ok.statusCode).toBe(201);

    // Reset so other tests aren't affected.
    await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentBodyMaxBytes",
      headers: { cookie },
      payload: { value: 32768 },
    });
  });

  it("ignores admin-supplied cap below the lower clamp (1 KB)", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentBodyMaxBytes",
      headers: { cookie },
      payload: { value: 100 }, // below the 1024 lower clamp
    });
    expect(set.statusCode).toBe(200);
    // Route ignores it (falls back to default) — 32 KB still works.
    const ok = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: "t".repeat(32768) },
    });
    expect(ok.statusCode).toBe(201);
    await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentBodyMaxBytes",
      headers: { cookie },
      payload: { value: 32768 },
    });
  });

  it("ignores admin-supplied cap above the upper clamp (1 MB)", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentBodyMaxBytes",
      headers: { cookie },
      payload: { value: 5 * 1024 * 1024 }, // above the 1 MB upper clamp
    });
    expect(set.statusCode).toBe(200);
    // Falls back to default; 32 KB-oversize body still rejected with the default message.
    const tooBig = "u".repeat(32769);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/comments`,
      headers: { cookie },
      payload: { rangeFrom: 0, rangeTo: 4, body: tooBig },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/32768 characters/);
    await app.inject({
      method: "PUT",
      url: "/api/settings/limits.commentBodyMaxBytes",
      headers: { cookie },
      payload: { value: 32768 },
    });
  });
});

// ===========================================================================
// Plugin upload cap
// ===========================================================================

describe("slice-44: plugin upload cap", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let paths: string;

  beforeAll(async () => {
    paths = freshDbPath("pl");
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();
    // Module-level DB singleton means the comment describe's signups
    // already exist in the DB; a fresh signup here is *not* the first
    // user and so is not auto-promoted by the bootstrap hook. Promote
    // via the DB directly so the plugin admin cookie is actually admin.
    const email = `limits-pl-${randomBytes(3).toString("hex")}@test.local`;
    const { cookie: c, userId } = await signup(app, email);
    adminCookie = c;
    const { getDb } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await getDb().db.update(users).set({ isAdmin: true, suspended: false }).where(eq(users.id, userId));
  });

  afterAll(async () => {
    await app.close();
    cleanup(paths);
  });

  it("accepts a small plugin zip under the default 50 MB cap", async () => {
    // We don't need to actually upload a valid zip here — we're just
    // proving the cap path doesn't fire for a small payload. The fake
    // bytes will fail validation downstream with a non-413 status,
    // which is the proof that the cap accepted them.
    const tiny = Buffer.from("fake-zip-bytes");
    const boundary = `----test-${randomBytes(4).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      tiny,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: {
        cookie: adminCookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect([400, 500]).toContain(res.statusCode);
  });

  it("rejects an upload whose Content-Length exceeds the cap with 413", async () => {
    // Lower the cap to 2 MB (within the route's 1 MB .. 500 MB clamp)
    // and POST a 3 MB payload. The Content-Length pre-check should
    // trip before we ever read the buffer.
    const NEW_CAP = 2 * 1024 * 1024;
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.pluginUploadMaxBytes",
      headers: { cookie: adminCookie },
      payload: { value: NEW_CAP },
    });
    expect(set.statusCode).toBe(200);

    const huge = Buffer.alloc(3 * 1024 * 1024, 0x61); // 3 MB of 'a'
    const boundary = `----test-${randomBytes(4).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      huge,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: {
        cookie: adminCookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    // Per-route check fires with 413. (Fastify's multipart body parsing
    // also has its own fileSize ceiling, currently 500 MB, so 3 MB
    // reaches the route — only the cap rejects.)
    expect(res.statusCode).toBe(413);
    const responseBody = res.json() as { error?: string; declaredBytes?: number; limitBytes?: number };
    expect(responseBody.error).toMatch(/Plugin upload exceeds/i);
    expect(responseBody.limitBytes).toBe(NEW_CAP);

    // Reset cap so other tests aren't affected.
    await app.inject({
      method: "PUT",
      url: "/api/settings/limits.pluginUploadMaxBytes",
      headers: { cookie: adminCookie },
      payload: { value: 50 * 1024 * 1024 },
    });
  });

  it("falls back to default when admin sets a non-numeric plugin cap", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.pluginUploadMaxBytes",
      headers: { cookie: adminCookie },
      payload: { value: { weird: "shape" } },
    });
    expect(set.statusCode).toBe(200);
    // Route falls back to 50 MB; a tiny payload is fine (not 413) but
    // isn't a real zip so downstream rejects with non-413.
    const tiny = Buffer.from("fake-zip-bytes");
    const boundary = `----test-${randomBytes(4).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      tiny,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: {
        cookie: adminCookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).not.toBe(413);
  });

  it("ignores admin-supplied plugin cap above the upper clamp (500 MB)", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.pluginUploadMaxBytes",
      headers: { cookie: adminCookie },
      payload: { value: 999999999 }, // above 500 MB clamp
    });
    expect(set.statusCode).toBe(200);
    // Should fall back to 50 MB. A small payload is fine (not 413).
    const tiny = Buffer.from("fake-zip-bytes");
    const boundary = `----test-${randomBytes(4).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      tiny,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: {
        cookie: adminCookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).not.toBe(413);
  });
});

// ===========================================================================
// File upload cap (slice-44): default 25 MB, admin-tunable via the same
// /api/settings surface.
// ===========================================================================

describe("slice-44: file upload cap", () => {
  let app: FastifyInstance;
  let cookie: string;
  let branchId: string;
  let paths: string;

  beforeAll(async () => {
    paths = freshDbPath("file");
    const { buildApp } = await import("../app.js");
    app = await buildApp();
    await app.ready();
    // The DB is module-level singleton — earlier describes have already
    // signed up users, so this signup is NOT the first user and won't
    // be auto-promoted. Promote via DB so the cookie works on admin
    // routes like PUT /api/settings/*.
    const email = `limits-file-${randomBytes(3).toString("hex")}@test.local`;
    const { cookie: c, userId } = await signup(app, email);
    cookie = c;
    const { getDb } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await getDb().db.update(users).set({ isAdmin: true, suspended: false }).where(eq(users.id, userId));
    const spaceId = await createSpace(app, cookie, "limits-file");
    const page = await createPage(app, cookie, spaceId, "p");
    branchId = page.branchId;
  });

  afterAll(async () => {
    await app.close();
    cleanup(paths);
  });

  it("rejects an oversized file with 413 at the default 25 MB cap", async () => {
    const data = Buffer.alloc(30 * 1024 * 1024, 0x61); // 30 MB > 25 MB default
    const boundary = `----test-${randomBytes(4).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/files`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
  });

  it("accepts a small file under the default 25 MB cap", async () => {
    const data = Buffer.from("hello-bytes");
    const boundary = `----test-${randomBytes(4).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hello.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/files`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
  });

  it("lets the admin raise the cap to accept the 30 MB payload", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.fileUploadMaxBytes",
      headers: { cookie },
      payload: { value: 40 * 1024 * 1024 },
    });
    expect(set.statusCode).toBe(200);

    const data = Buffer.alloc(30 * 1024 * 1024, 0x61);
    const boundary = `----test-${randomBytes(4).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ok.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/files`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);

    // Reset for any later tests.
    await app.inject({
      method: "PUT",
      url: "/api/settings/limits.fileUploadMaxBytes",
      headers: { cookie },
      payload: { value: 25 * 1024 * 1024 },
    });
  });

  it("falls back to the default when the admin sets a non-numeric file cap", async () => {
    const set = await app.inject({
      method: "PUT",
      url: "/api/settings/limits.fileUploadMaxBytes",
      headers: { cookie },
      payload: { value: "not a number" },
    });
    expect(set.statusCode).toBe(200);
    // Route falls back to 25 MB; 30 MB upload should still be rejected.
    const data = Buffer.alloc(30 * 1024 * 1024, 0x61);
    const boundary = `----test-${randomBytes(4).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/files`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
  });
});
