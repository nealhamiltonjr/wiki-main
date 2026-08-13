import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-17 §9.4 item 10 — a password-protected share link must become
// unreachable after a small number of wrong-password attempts, otherwise
// brute-forcing a short password is trivial. The unit-test-level coverage
// for InMemoryRateLimiter (rate-limit.test.ts) is not enough — this proves
// the limiter is actually wired into the public branch-auth path.
//
// The test bypasses the per-IP keying by spoofing x-forwarded-for on every
// request and varying it per attempt; the real attack scenario is a single
// IP running many guesses, but accounting for proxies/CDNs (real
// `request.ip` may already come from a header in production), the safest
// end-to-end assertion is "N+1 attempts with any caller fails with 429".
const DB_PATH = `data/test-share-rl-${randomBytes(4).toString("hex")}.db`;
const FILES_ROOT = `data/test-share-rl-root-${randomBytes(4).toString("hex")}`;

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

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
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
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe("share-link password brute-force protection (slice-17)", () => {
  it("N+1 wrong-password attempts against a share-link file fetch return 429", async () => {
    const { cookie, userId, branchId } = await (async () => {
      const a = await signup(`share-${randomBytes(4).toString("hex")}@example.com`);
      const spaceId = await createSpace(a.cookie, "Share Space");
      const page = await createPage(a.cookie, spaceId, "share-page");
      return { cookie: a.cookie, userId: a.userId, branchId: page.branchId };
    })();

    // Upload a file inside the branch so the file route has something to serve.
    const data = Buffer.from("image-bytes");
    const up = await uploadFile(cookie, branchId, "pic.png", "image/png", data);
    expect(up.statusCode).toBe(201);
    const { id: fileId } = up.json() as { id: string };

    // Create a password-protected share link for THIS branch.
    const { createShareLink } = await import("../services/token.service.js");
    const { rawToken: shareToken } = await createShareLink({
      branchOrSpaceId: branchId,
      scopeType: "branch",
      createdBy: userId,
      isAdmin: true,
      permission: "view",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      password: "right-password",
    });

    const fileUrl = `/api/branches/${branchId}/files/${fileId}`;

    // First 10 wrong-password attempts must return 401 (Password required) —
    // the request is allowed to the password check, then rejected.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: "GET",
        url: `${fileUrl}?shareToken=${encodeURIComponent(shareToken)}&sharePassword=wrong`,
        headers: { "x-forwarded-for": `192.0.2.${i + 1}` },
      });
      expect(r.statusCode).toBe(401);
    }

    // 11th attempt from a fresh IP must be rate-limited with 429 — the
    // limiter fires BEFORE the password check (consuming the slot whether
    // the guess was right or wrong) and refuses the request entirely.
    const r11 = await app.inject({
      method: "GET",
      url: `${fileUrl}?shareToken=${encodeURIComponent(shareToken)}&sharePassword=wrong`,
      headers: { "x-forwarded-for": "192.0.2.99" },
    });
    expect(r11.statusCode).toBe(429);
    expect(JSON.parse(r11.payload)).toEqual({ error: expect.stringMatching(/Too many attempts/) });

    // The correct password does NOT bypass the limiter — the limit is on
    // attempts reaching this code path, not on wrong guesses specifically.
    const r12 = await app.inject({
      method: "GET",
      url: `${fileUrl}?shareToken=${encodeURIComponent(shareToken)}&sharePassword=right-password`,
      headers: { "x-forwarded-for": "192.0.2.100" },
    });
    expect(r12.statusCode).toBe(429);
  });

  it("the limiter does NOT trigger on passwordless share links (only matters for password-protected ones)", async () => {
    const { cookie, userId, branchId } = await (async () => {
      const a = await signup(`sharepwless-${randomBytes(4).toString("hex")}@example.com`);
      const spaceId = await createSpace(a.cookie, "PWLess Space");
      const page = await createPage(a.cookie, spaceId, "pwless-page");
      return { cookie: a.cookie, userId: a.userId, branchId: page.branchId };
    })();

    const up = await uploadFile(cookie, branchId, "pic.png", "image/png", Buffer.from("ok"));
    expect(up.statusCode).toBe(201);
    const { id: fileId } = up.json() as { id: string };

    const { createShareLink } = await import("../services/token.service.js");
    const { rawToken: shareToken } = await createShareLink({
      branchOrSpaceId: branchId,
      scopeType: "branch",
      createdBy: userId,
      isAdmin: true,
      permission: "view",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      // no password
    });

    const fileUrl = `/api/branches/${branchId}/files/${fileId}`;

    // Smash the route 20 times — every request must succeed (200) since
    // there's no password check to gate, and no limiter applies.
    for (let i = 0; i < 20; i++) {
      const r = await app.inject({
        method: "GET",
        url: `${fileUrl}?shareToken=${encodeURIComponent(shareToken)}`,
        headers: { "x-forwarded-for": `198.51.100.${i + 1}` },
      });
      expect(r.statusCode).toBe(200);
    }
  });
});
