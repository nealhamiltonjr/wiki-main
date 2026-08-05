import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-ancestry.db";
const TEST_REPO_ROOT = "./data/test-ancestry-repo";
const TEST_FILES_ROOT = "./data/test-ancestry-files";
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "anc-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "anc-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

let cookie: string;
let spaceId: string;

interface CreatedPage { pageId: string; branchId: string }
async function createPage(opts: { slug: string; title?: string; parentBranchId?: string | null }): Promise<CreatedPage> {
  const res = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: { cookie },
    payload: { slug: opts.slug, title: opts.title, spaceId, parentBranchId: opts.parentBranchId ?? null },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as CreatedPage;
}

beforeAll(async () => {
  const signup = await app.inject({ method: "POST", url: "/api/auth/sign-up/email", payload: { email: "ancestry@example.com", password: "pw-ancestry", name: "Admin" } });
  cookie = extractCookie(signup.headers["set-cookie"]);
  const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Ancestry" } });
  spaceId = JSON.parse(space.body).id as string;
});

describe("breadcrumb ancestry (UI overhaul B8)", () => {
  it("returns the leaf-first ancestor trail skipping the system root", async () => {
    const root = await createPage({ slug: "root-page", title: "Root Page" });
    const child = await createPage({ slug: "child-page", title: "Child Page", parentBranchId: root.branchId });
    const grandchild = await createPage({ slug: "grandchild-page", title: "Grandchild Page", parentBranchId: child.branchId });

    const res = await app.inject({ method: "GET", url: `/api/branches/${grandchild.branchId}/ancestry`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.space.id).toBe(spaceId);
    expect(body.space.name).toBe("Ancestry");
    expect(body.trail.map((t: { slug: string }) => t.slug)).toEqual(["root-page", "child-page", "grandchild-page"]);
    expect(body.trail.map((t: { title: string }) => t.title)).toEqual(["Root Page", "Child Page", "Grandchild Page"]);
  });

  it("a flat page's trail is just itself (system root scaffold skipped)", async () => {
    const p = await createPage({ slug: "flat-page", title: "Flat Page" });
    const res = await app.inject({ method: "GET", url: `/api/branches/${p.branchId}/ancestry`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trail.map((t: { slug: string }) => t.slug)).toEqual(["flat-page"]);
  });

  it("includes the page icon attribute when one is set", async () => {
    const p = await createPage({ slug: "icon-page", title: "Icon Page" });
    const attr = await app.inject({
      method: "POST",
      url: `/api/branches/${p.branchId}/attributes`,
      headers: { cookie },
      payload: { name: "icon", value: "🌻", isPromoted: false },
    });
    expect(attr.statusCode).toBe(201);

    const res = await app.inject({ method: "GET", url: `/api/branches/${p.branchId}/ancestry`, headers: { cookie } });
    expect(JSON.parse(res.body).trail[0].icon).toBe("🌻");
  });

  it("404s for an unknown branch", async () => {
    const res = await app.inject({ method: "GET", url: "/api/branches/nope/ancestry", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});
