import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-backlinks.db";
const TEST_REPO_ROOT = "./data/test-backlinks-repo";
const TEST_FILES_ROOT = "./data/test-backlinks-files";
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "bl-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "bl-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let app: FastifyInstance;

function extractCookie(h: string | string[] | undefined): string {
  const r = Array.isArray(h) ? h[0] : h;
  return r?.split(";")[0] ?? "";
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

async function signup(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/sign-up/email", payload: { email, password: "pw-" + email, name: "X" } });
  return extractCookie(res.headers["set-cookie"]);
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  return JSON.parse(res.body).id as string;
}

async function createPage(cookie: string, spaceId: string, slug: string) {
  const res = await app.inject({ method: "POST", url: "/api/pages", headers: { cookie }, payload: { slug, spaceId, parentBranchId: null } });
  return JSON.parse(res.body) as { pageId: string; branchId: string };
}

describe("backlinks (§7.12 block-refs + backlinks)", () => {
  it("extracts and stores backlinks on page save", async () => {
    const c = await signup("bl-test@example.com");
    const spaceId = await createSpace(c, "BL");
    const pageA = await createPage(c, spaceId, "page-a");
    const pageB = await createPage(c, spaceId, "page-b");

    // Save page A with a link to page B's API URL
    const contentA = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "go to B", marks: [{ type: "link", attrs: { href: `/api/branches/${pageB.branchId}/page` } }] }],
      }],
    };
    const getA = await app.inject({ method: "GET", url: `/api/branches/${pageA.branchId}/page`, headers: { cookie: c } });
    const updatedAtA = JSON.parse(getA.body).updatedAt;
    await app.inject({
      method: "PUT", url: `/api/pages/${pageA.pageId}/branches/${pageA.branchId}`, headers: { cookie: c },
      payload: { content: contentA, expectedUpdatedAt: updatedAtA },
    });

    // Query backlinks for page B — should get 1 from A
    const bl = await app.inject({ method: "GET", url: `/api/pages/${pageB.pageId}/backlinks`, headers: { cookie: c } });
    expect(bl.statusCode).toBe(200);
    const list = JSON.parse(bl.body).backlinks;
    expect(list).toHaveLength(1);
    expect(list[0].sourceSlug).toBe("page-a");
    expect(list[0].sourceBranchId).toBeTruthy();
  });

  it("removes stale backlinks on re-save", async () => {
    const c = await signup("bl-stale@example.com");
    const spaceId = await createSpace(c, "BL2");
    const pageA = await createPage(c, spaceId, "a");
    const pageB = await createPage(c, spaceId, "b");
    const pageC = await createPage(c, spaceId, "c");

    // Link A → B
    const linkB = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: `/api/branches/${pageB.branchId}/page` } }] }] }] };
    const getA1 = await app.inject({ method: "GET", url: `/api/branches/${pageA.branchId}/page`, headers: { cookie: c } });
    await app.inject({ method: "PUT", url: `/api/pages/${pageA.pageId}/branches/${pageA.branchId}`, headers: { cookie: c }, payload: { content: linkB, expectedUpdatedAt: JSON.parse(getA1.body).updatedAt } });

    // Verify: B has 1 backlink from A
    const bl1 = await app.inject({ method: "GET", url: `/api/pages/${pageB.pageId}/backlinks`, headers: { cookie: c } });
    expect(JSON.parse(bl1.body).backlinks).toHaveLength(1);

    // Now A links to C instead → B's backlink should disappear
    const linkC = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: `/api/branches/${pageC.branchId}/page` } }] }] }] };
    const getA2 = await app.inject({ method: "GET", url: `/api/branches/${pageA.branchId}/page`, headers: { cookie: c } });
    await app.inject({ method: "PUT", url: `/api/pages/${pageA.pageId}/branches/${pageA.branchId}`, headers: { cookie: c }, payload: { content: linkC, expectedUpdatedAt: JSON.parse(getA2.body).updatedAt } });

    const bl2 = await app.inject({ method: "GET", url: `/api/pages/${pageB.pageId}/backlinks`, headers: { cookie: c } });
    expect(JSON.parse(bl2.body).backlinks).toHaveLength(0);

    const bl3 = await app.inject({ method: "GET", url: `/api/pages/${pageC.pageId}/backlinks`, headers: { cookie: c } });
    expect(JSON.parse(bl3.body).backlinks).toHaveLength(1);
  });

  it("detects block-level links", async () => {
    const c = await signup("bl-block@example.com");
    const spaceId = await createSpace(c, "BL3");
    const pageA = await createPage(c, spaceId, "a");
    const pageB = await createPage(c, spaceId, "b");

    const content = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "ref", marks: [{ type: "link", attrs: { href: `/api/branches/${pageB.branchId}/page#block-X1` } }] }],
      }],
    };
    const getA = await app.inject({ method: "GET", url: `/api/branches/${pageA.branchId}/page`, headers: { cookie: c } });
    await app.inject({ method: "PUT", url: `/api/pages/${pageA.pageId}/branches/${pageA.branchId}`, headers: { cookie: c }, payload: { content, expectedUpdatedAt: JSON.parse(getA.body).updatedAt } });

    const bl = await app.inject({ method: "GET", url: `/api/pages/${pageB.pageId}/backlinks`, headers: { cookie: c } });
    const list = JSON.parse(bl.body).backlinks;
    expect(list).toHaveLength(1);
    expect(list[0].targetBlockId).toBe("block-X1");
  });
});
