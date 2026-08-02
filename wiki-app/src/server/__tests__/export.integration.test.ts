import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { crc32 } from "node:zlib";

const TEST_DB_PATH = "./data/test-export.db";
const TEST_REPO_ROOT = "./data/test-export-repo";
const TEST_FILES_ROOT = "./data/test-export-files";
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "test-only-key-do-not-use-in-real-deployment";

let app: FastifyInstance;
let db: typeof import("../db/index.js").db;

function extractCookie(h: string | string[] | undefined): string {
  const r = Array.isArray(h) ? h[0] : h;
  return r?.split(";")[0] ?? "";
}

async function signup(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery-staple", name: "T" },
  });
  return extractCookie(res.headers["set-cookie"]);
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function createPage(cookie: string, spaceId: string, slug: string, parentBranchId: string | null = null) {
  const res = await app.inject({
    method: "POST", url: "/api/pages", headers: { cookie },
    payload: { slug, spaceId, parentBranchId },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { pageId: string; branchId: string };
}

async function saveContent(cookie: string, pageId: string, branchId: string, content: unknown) {
  const get = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
  const updatedAt = JSON.parse(get.body).updatedAt as string;
  const res = await app.inject({
    method: "PUT", url: `/api/pages/${pageId}/branches/${branchId}`, headers: { cookie },
    payload: { content, expectedUpdatedAt: updatedAt },
  });
  expect(res.statusCode).toBe(200);
}

let aliceCookie: string;
let bobCookie: string;
let spaceId: string;
let pageId: string;
let branchId: string;

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  for (const p of [TEST_DB_PATH, TEST_REPO_ROOT, TEST_FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });
  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();
  db = (await import("../db/index.js")).db;

  aliceCookie = await signup("export-alice@example.com");
  bobCookie = await signup("export-bob@example.com");
  spaceId = await createSpace(aliceCookie, "Exports");

  // Bob needs space viewer access for the restricted-ancestor export test.
  const { users, spaceMembers } = await import("../db/schema.js");
  const [bob] = await db.select({ id: users.id }).from(users).where(sql`email = 'export-bob@example.com'`);
  await db.insert(spaceMembers).values({ spaceId, userId: bob!.id, role: "viewer" }).run();

  const p = await createPage(aliceCookie, spaceId, "test-page");
  pageId = p.pageId;
  branchId = p.branchId;
});

afterAll(async () => {
  await app.close();
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_REPO_ROOT, TEST_FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

describe("single-page export (§7.11)", () => {
  it("returns clean markdown with frontmatter by default", async () => {
    // Save a page with a heading so title extraction works
    const content = { type: "doc", content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hello World" }] },
      { type: "paragraph", content: [{ type: "text", text: "Some text." }] },
    ] };
    await saveContent(aliceCookie, pageId, branchId, content);

    const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/export`, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");

    const body = res.body;
    expect(body).toContain("---");
    expect(body).toContain("title:"); // Hello World
    expect(body).toContain('"test-page"'); // slug: "test-page"
    expect(body).toContain("# Hello World");
    expect(body).toContain("Some text.");
  });

  it("omits frontmatter when disabled", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/branches/${branchId}/export?frontmatter=0`,
      headers: { cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("---");
  });

  it("strips internal links to plain text", async () => {
    // Save content with an internal link
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "visit", marks: [{ type: "link", attrs: { href: "/api/spaces" } }] }] }] };
    await saveContent(aliceCookie, pageId, branchId, content);

    const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/export?frontmatter=0`, headers: { cookie: aliceCookie } });
    // The link should be stripped - just "visit" not "[visit](/api/spaces)"
    expect(res.body).toContain("visit");
    expect(res.body).not.toContain("[visit](/api/spaces)");
  });

  it("returns a zip when images=copy", async () => {
    const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/export?images=copy`, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");

    // Verify zip signature on the raw payload
    const buf = Buffer.isBuffer(res.rawPayload) ? res.rawPayload : Buffer.from(res.body as string, "binary");
    expect(buf.readUInt32LE(0)).toBe(0x04034b50); // PK signature
  });
});

describe("space export (§7.11)", () => {
  it("returns a zip with pages/*.md", async () => {
    const p2 = await createPage(aliceCookie, spaceId, "second-page");
    await createPage(aliceCookie, spaceId, "third-page", p2.branchId);

    const res = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/export`, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");

    const buf = Buffer.isBuffer(res.rawPayload) ? res.rawPayload : Buffer.from(res.body as string, "binary");
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);

    // Filenames in the zip are stored as raw bytes; the store-only zip keeps
    // them contiguous so a toString('latin1') shows them uncorrupted.
    const raw = buf.toString("latin1");
    expect(raw).toContain("pages/test-page.md");
    expect(raw).toContain("pages/second-page.md");
    expect(raw).toContain("pages/third-page.md");
  });

  it("skips pages the caller cannot read (restricted-ancestor)", async () => {
    const { branchId: secretBranch } = await createPage(aliceCookie, spaceId, "secret-only");
    const { users } = await import("../db/schema.js");

    // Promote alice to global admin so she can create groups.
    await db.update(users).set({ isAdmin: true }).where(sql`email = 'export-alice@example.com'`).run();
    const eng = await app.inject({ method: "POST", url: "/api/groups", headers: { cookie: aliceCookie }, payload: { name: "Eng" } });
    expect(eng.statusCode).toBe(201);
    const engId = JSON.parse(eng.body).id;

    const put = await app.inject({
      method: "PUT",
      url: `/api/branches/${secretBranch}/permissions`,
      headers: { cookie: aliceCookie },
      payload: { grants: [{ groupId: engId, role: "editor" }] },
    });
    expect(put.statusCode).toBe(200); // alice is now admin

    // Bob is space viewer, not in Eng → secret-only not in his export
    const bobRes = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/export`, headers: { cookie: bobCookie } });
    const bobBuf = Buffer.isBuffer(bobRes.rawPayload) ? bobRes.rawPayload : Buffer.from(bobRes.body as string, "binary");
    const bobRaw = bobBuf.toString("latin1");
    expect(bobRaw).not.toContain("secret-only");

    // Alice's export includes it
    const aliceRes = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/export`, headers: { cookie: aliceCookie } });
    const aliceBuf = Buffer.isBuffer(aliceRes.rawPayload) ? aliceRes.rawPayload : Buffer.from(aliceRes.body as string, "binary");
    const aliceRaw = aliceBuf.toString("latin1");
    expect(aliceRaw).toContain("secret-only");
  });
});
