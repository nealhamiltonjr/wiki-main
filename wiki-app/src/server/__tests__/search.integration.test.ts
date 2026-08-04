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

  it("finds partial and stemmed words via prefix + porter", async () => {
    const c = await signupAsAdmin("search-prefix@example.com");
    const spaceId = await createSpace(c, "SRCH");
    const { pageId, branchId } = await createPage(c, spaceId, "linux-notes");

    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "The Linux networking codebase lives under net/." }] },
      ],
    };
    await savePage(c, pageId, branchId, doc);

    // Prefix: "net" should match "networking"
    const r1 = await app.inject({ method: "GET", url: "/api/search?q=net", headers: { cookie: c } });
    const results1 = JSON.parse(r1.body).results as { slug: string }[];
    expect(results1.some(r => r.slug === "linux-notes")).toBe(true);

    // Multi-word AND: bare words "linux network code" must match the page
    const r2 = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent("linux network code")}`, headers: { cookie: c } });
    const results2 = JSON.parse(r2.body).results as { slug: string }[];
    expect(results2.some(r => r.slug === "linux-notes")).toBe(true);

    // "codebase" stems to "codebas", so "code" alone (stemmed) also matches
    const r3 = await app.inject({ method: "GET", url: "/api/search?q=code", headers: { cookie: c } });
    const results3 = JSON.parse(r3.body).results as { slug: string }[];
    expect(results3.some(r => r.slug === "linux-notes")).toBe(true);

    // Quoted phrase requires adjacency; "linux code" is not adjacent so no match
    const r4 = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent('"linux code"')}`, headers: { cookie: c } });
    const results4 = JSON.parse(r4.body).results as { slug: string }[];
    expect(results4.some(r => r.slug === "linux-notes")).toBe(false);
  });

  it("returns spaces alongside pages", async () => {
    const c = await signupAsAdmin("search-spaces@example.com");
    const spaceId = await createSpace(c, "Linux Laptop");
    const { pageId, branchId } = await createPage(c, spaceId, "arch-install");

    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Arch Install" }] },
        { type: "paragraph", content: [{ type: "text", text: "Linux dual-boot setup steps for a ThinkPad." }] },
      ],
    };
    await savePage(c, pageId, branchId, doc);

    // Space name match should appear in `spaces` with a page count
    const r = await app.inject({ method: "GET", url: "/api/search?q=linux", headers: { cookie: c } });
    const body = JSON.parse(r.body);
    const space = (body.spaces as { id: string; name: string; pageCount: number }[]).find(s => s.id === spaceId);
    expect(space).toBeDefined();
    expect(space!.name).toBe("Linux Laptop");
    expect(space!.pageCount).toBeGreaterThanOrEqual(1);

    // Page results now carry the space name for display
    const page = (body.results as { slug: string; spaceName: string }[]).find(p => p.slug === "arch-install");
    expect(page).toBeDefined();
    expect(page!.spaceName).toBe("Linux Laptop");
  });

  it("returns empty for empty query", async () => {
    const c = await signupAsAdmin("search-empty@example.com");
    const r = await app.inject({ method: "GET", url: "/api/search?q=", headers: { cookie: c } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).results).toHaveLength(0);
    expect(JSON.parse(r.body).spaces).toHaveLength(0);
  });
});
