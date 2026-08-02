import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-search.db";
const TEST_REPO_ROOT = "./data/test-search-repo";
const TEST_FILES_ROOT = "./data/test-search-files";
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "s-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "s-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

async function signupAsAdmin(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/sign-up/email", payload: { email, password: "pw-" + email, name: "Admin" } });
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

async function savePage(cookie: string, pageId: string, branchId: string, content: unknown) {
  const current = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
  const page = JSON.parse(current.body);
  const res = await app.inject({
    method: "PUT", url: `/api/pages/${pageId}/branches/${branchId}`,
    headers: { cookie }, payload: { content, expectedUpdatedAt: page.updatedAt ?? null },
  });
  return res;
}

describe("search (§7.12d.2)", () => {
  it("indexes on save and returns FTS results", async () => {
    const c = await signupAsAdmin("search-test@example.com");
    const spaceId = await createSpace(c, "SRCH");
    const { pageId, branchId } = await createPage(c, spaceId, "alpine-guide");

    // Save a page with recognizable content for FTS
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Alpine Guide" }] },
        { type: "paragraph", content: [{ type: "text", text: "How to climb Mt. Rainier safely with crampons and ice axe." }] },
      ],
    };
    const saveRes = await savePage(c, pageId, branchId, doc);

    // Search should find it
    const r1 = await app.inject({ method: "GET", url: "/api/search?q=crampons", headers: { cookie: c } });
    expect(r1.statusCode).toBe(200);
    const results = JSON.parse(r1.body).results as unknown[];
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = (results[0] as { slug: string; snippet: string }) ?? {};
    expect(match.slug).toBe("alpine-guide");
    expect(match.snippet).toMatch(/crampons/i);

    // Search for nonexistent term
    const r2 = await app.inject({ method: "GET", url: "/api/search?q=xyzzy", headers: { cookie: c } });
    expect(JSON.parse(r2.body).results).toHaveLength(0);
  });

  it("returns empty for empty query", async () => {
    const c = await signupAsAdmin("search-empty@example.com");
    const r = await app.inject({ method: "GET", url: "/api/search?q=", headers: { cookie: c } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).results).toHaveLength(0);
  });
});
