import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-7 gate (brief §3.2 file-hardening): uploads and downloads through a
// branch placement. Regression tests ported from the old app:
//   - a file whose stored MIME claims text/html must be forced to download
//     (Content-Disposition: attachment) with nosniff set — never rendered inline
//   - an allowlisted raster image stays inline (no attachment header)
//   - SVG is NOT allowlisted (can carry a script)
//   - oversized uploads fail cleanly with 413, never a bare 500
//   - branch-context: a file id can't be used to read content through an
//     unrelated branch (§3.13a)
// Env vars MUST be set before the app module is imported.
const DB_PATH = `data/test-files-${randomBytes(4).toString("hex")}.db`;
const FILES_ROOT = `data/test-files-root-${randomBytes(4).toString("hex")}`;

process.env.DB_PATH = DB_PATH;
process.env.FILES_ROOT = FILES_ROOT;
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
    payload: { slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

function multipartBody(boundary: string, filename: string, mimeType: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function uploadFile(cookie: string, branchId: string, filename: string, mimeType: string, data: Buffer) {
  const boundary = `----test-${randomBytes(4).toString("hex")}`;
  return app.inject({
    method: "POST",
    url: `/api/branches/${branchId}/files`,
    headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody(boundary, filename, mimeType, data),
  });
}

async function setupSpace(): Promise<{ cookie: string; branchId: string; pageId: string }> {
  const a = await signup(`files-${randomBytes(4).toString("hex")}@example.com`);
  const spaceId = await createSpace(a.cookie, "Files Space");
  const page = await createPage(a.cookie, spaceId, "files-page");
  return { cookie: a.cookie, branchId: page.branchId, pageId: page.pageId };
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  // Reset singletons from a previous test file (vitest runs sequentially).
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
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe("file upload + serving hardening", () => {
  it("uploads an image and serves it inline (allowlisted) with nosniff", async () => {
    const { cookie, branchId } = await setupSpace();
    const data = Buffer.from("fake-png-bytes");

    const upload = await uploadFile(cookie, branchId, "pic.png", "image/png", data);
    expect(upload.statusCode).toBe(201);
    const { id: fileId, filename } = upload.json();
    expect(filename).toBe("pic.png");

    const dl = await app.inject({ method: "GET", url: `/api/branches/${branchId}/files/${fileId}`, headers: { cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("image/png");
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    // Allowlisted raster image → inline, no attachment header.
    expect(dl.headers["content-disposition"]).toBeUndefined();
    expect(dl.rawPayload.equals(data)).toBe(true);
  });

  it("forces a file claiming text/html to download with nosniff — never inline", async () => {
    const { cookie, branchId } = await setupSpace();
    const html = Buffer.from("<script>alert(1)</script>");

    const upload = await uploadFile(cookie, branchId, "evil.html", "text/html", html);
    expect(upload.statusCode).toBe(201);
    const { id: fileId } = upload.json();

    const dl = await app.inject({ method: "GET", url: `/api/branches/${branchId}/files/${fileId}`, headers: { cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    // text/html is outside the inline-safe allowlist → forced download.
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; /);
  });

  it("forces SVG downloads (not inline — SVG can carry a script)", async () => {
    const { cookie, branchId } = await setupSpace();
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);

    const upload = await uploadFile(cookie, branchId, "diagram.svg", "image/svg+xml", svg);
    expect(upload.statusCode).toBe(201);
    const { id: fileId } = upload.json();

    const dl = await app.inject({ method: "GET", url: `/api/branches/${branchId}/files/${fileId}`, headers: { cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; /);
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects an oversized upload with 413, not a bare 500", async () => {
    const { cookie, branchId } = await setupSpace();
    const huge = randomBytes(30 * 1024 * 1024); // 30MB > 25MB cap

    const res = await uploadFile(cookie, branchId, "huge.jpg", "image/jpeg", huge);
    expect(res.statusCode).toBe(413);
    expect(JSON.stringify(res.body)).toMatch(/too large/i);
  });

  it("serves the file only through its OWN branch — other branches 404 (§3.13a)", async () => {
    const { cookie, branchId } = await setupSpace();
    const upload = await uploadFile(cookie, branchId, "secret.png", "image/png", Buffer.from("secret"));
    expect(upload.statusCode).toBe(201);
    const { id: fileId } = upload.json();

    // Create a second space + page (different branch, different page) and try
    // to read the first page's file through it.
    const { getDb } = await import("../db/index.js");
    const { branches, spaces, spaceMembers, pages } = await import("../db/schema.js");
    const a = await signup(`other-${randomBytes(4).toString("hex")}@example.com`);
    const s2 = crypto.randomUUID();
    await getDb().db.insert(spaces).values({ id: s2, name: "S2", createdBy: a.userId });
    await getDb().db.insert(spaceMembers).values({ spaceId: s2, userId: a.userId, role: "admin" });
    const otherPageId = crypto.randomUUID();
    await getDb().db.insert(pages).values({
      id: otherPageId, slug: "other", title: "Other", ownerId: a.userId,
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    const otherBranchId = crypto.randomUUID();
    await getDb().db.insert(branches).values({
      id: otherBranchId, pageId: otherPageId, spaceId: s2, createdBy: a.userId, isSystem: false,
    });

    const dl = await app.inject({ method: "GET", url: `/api/branches/${otherBranchId}/files/${fileId}`, headers: { cookie: a.cookie } });
    expect(dl.statusCode).toBe(404);
  });

  it("rejects anonymous downloads without a share token", async () => {
    const { cookie, branchId } = await setupSpace();
    const upload = await uploadFile(cookie, branchId, "pic.png", "image/png", Buffer.from("bytes"));
    expect(upload.statusCode).toBe(201);
    const { id: fileId } = upload.json();

    const anon = await app.inject({ method: "GET", url: `/api/branches/${branchId}/files/${fileId}` });
    expect(anon.statusCode).toBe(401);
  });
});
