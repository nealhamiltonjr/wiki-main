import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-attrs.db";
const TEST_REPO_ROOT = "./data/test-attrs-repo";
const TEST_FILES_ROOT = "./data/test-attrs-files";
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "at-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "at-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
  // First user is auto-admin
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

describe("attributes (§7.12d.2)", () => {
  it("CRUD: create, list, update, delete", async () => {
    const c = await signupAsAdmin("attr-test@example.com");
    const spaceId = await createSpace(c, "ATTR");
    const { pageId, branchId } = await createPage(c, spaceId, "test-page");

    // Create
    const r1 = await app.inject({ method: "POST", url: `/api/branches/${branchId}/attributes`, headers: { cookie: c }, payload: { name: "sourceUrl", value: "https://example.com", isPromoted: true } });
    expect(r1.statusCode).toBe(201);
    const a1 = JSON.parse(r1.body);
    expect(a1.name).toBe("sourceUrl");
    expect(a1.isPromoted).toBe(true);

    // List
    const r2 = await app.inject({ method: "GET", url: `/api/branches/${branchId}/attributes`, headers: { cookie: c } });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body).attributes).toHaveLength(1);

    // Update
    const r3 = await app.inject({ method: "PUT", url: `/api/attributes/${a1.id}`, headers: { cookie: c }, payload: { value: "https://updated.com" } });
    expect(r3.statusCode).toBe(200);
    expect(JSON.parse(r3.body).value).toBe("https://updated.com");

    // Delete
    const r4 = await app.inject({ method: "DELETE", url: `/api/attributes/${a1.id}`, headers: { cookie: c } });
    expect(r4.statusCode).toBe(200);

    // List after delete
    const r5 = await app.inject({ method: "GET", url: `/api/branches/${branchId}/attributes`, headers: { cookie: c } });
    expect(JSON.parse(r5.body).attributes).toHaveLength(0);
  });
});
