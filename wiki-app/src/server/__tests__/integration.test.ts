import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-integration.db";
const TEST_REPO_ROOT = "./data/test-integration-repo";
const TEST_FILES_ROOT = "./data/test-integration-files";

process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "test-only-key-do-not-use-in-real-deployment";

let app: FastifyInstance;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
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

describe("permission middleware - fail-closed behavior", () => {
  it("denies an unauthenticated request to a protected route", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/logs" });
    expect(res.statusCode).toBe(401);
  });

  it("a genuinely unmatched /api/ route still 404s in dev mode (not our custom production 404, since that only registers under NODE_ENV=production - see the production describe block below for that case)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/totally-made-up" });
    expect(res.statusCode).toBe(404);
  });

  it("a malformed request body gets a clean 400 with issues, not a raw 500 (regression test for the unhandled ZodError bug)", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "zodcheck@example.com", password: "correct-horse-battery-staple", name: "Zod" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);

    const res = await app.inject({
      method: "POST",
      url: "/api/spaces",
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validation failed");
    expect(body.issues.length).toBeGreaterThan(0);
  });
});

describe("end-to-end: register -> space -> page -> save -> fetch", () => {
  it("a full happy path works and OCC conflicts are detected", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "e2e@example.com", password: "correct-horse-battery-staple", name: "E2E" },
    });
    expect(signup.statusCode).toBe(200);
    const cookie = extractCookie(signup.headers["set-cookie"]);

    const space = await app.inject({
      method: "POST",
      url: "/api/spaces",
      headers: { cookie },
      payload: { name: "Test Space" },
    });
    expect(space.statusCode).toBe(201);
    const spaceId = JSON.parse(space.body).id;

    const page = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "test-page", spaceId, parentBranchId: null },
    });
    expect(page.statusCode).toBe(201);
    const { pageId, branchId } = JSON.parse(page.body);

    const fetched = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    expect(fetched.statusCode).toBe(200);
    const { updatedAt, content } = JSON.parse(fetched.body);

    // Regression test for a real bug: a brand-new page's default content was
    // `{ type: "doc", content: [] }` - zero block nodes, which ProseMirror
    // doesn't treat as a valid, clickable document. Every new page must start
    // with at least one block node (an empty paragraph) so the editor is
    // actually interactive the moment it's created.
    expect(content.content.length).toBeGreaterThan(0);

    const save = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageId}/branches/${branchId}`,
      headers: { cookie },
      payload: { content: { type: "doc", content: [] }, expectedUpdatedAt: updatedAt },
    });
    expect(save.statusCode).toBe(200);

    const staleSave = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageId}/branches/${branchId}`,
      headers: { cookie },
      payload: { content: { type: "doc", content: [] }, expectedUpdatedAt: updatedAt },
    });
    expect(staleSave.statusCode).toBe(409);
  });

  it("a second user with no space membership is denied access to that page", async () => {
    const signupA = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "owner@example.com", password: "correct-horse-battery-staple", name: "Owner" },
    });
    const cookieA = extractCookie(signupA.headers["set-cookie"]);
    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie: cookieA }, payload: { name: "Private" } });
    const spaceId = JSON.parse(space.body).id;
    const page = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie: cookieA },
      payload: { slug: "secret", spaceId, parentBranchId: null },
    });
    const { branchId } = JSON.parse(page.body);

    const signupB = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "outsider2@example.com", password: "correct-horse-battery-staple", name: "Outsider" },
    });
    const cookieB = extractCookie(signupB.headers["set-cookie"]);

    const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(403);
  });
});

describe("production static serving - regression test for the original bug", () => {
  let prodApp: FastifyInstance;

  beforeAll(async () => {
    execSync("npx vite build", { stdio: "pipe" });
    process.env.NODE_ENV = "production";
    const { buildApp } = await import("../app.js");
    prodApp = await buildApp();
    await prodApp.ready();
  });

  afterAll(async () => {
    await prodApp.close();
    process.env.NODE_ENV = "";
    rmSync("./dist", { recursive: true, force: true });
  });

  it("serves the SPA shell at the root", async () => {
    const res = await prodApp.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<div id=\"root\">");
  });

  it("serves the SPA shell for a client-side route on hard refresh", async () => {
    const res = await prodApp.inject({ method: "GET", url: "/pages/some-fake-branch-id" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<div id=\"root\">");
  });

  it("THE ORIGINAL BUG: a genuinely unmatched /api/ route must 404 cleanly, not 500 - this broke twice before the onRoute-time validation fix", async () => {
    const res = await prodApp.inject({ method: "GET", url: "/api/totally-made-up" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
  });

  it("the API itself still works normally on the same port", async () => {
    const res = await prodApp.inject({ method: "GET", url: "/api/admin/logs" });
    expect(res.statusCode).toBe(401);
  });
});

describe("user settings - personal preferences, isolated per user", () => {
  it("a user can set and read their own settings, and another user never sees them", async () => {
    const signupA = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "settingsuser1@example.com", password: "correct-horse-battery-staple", name: "SU1" },
    });
    const cookieA = extractCookie(signupA.headers["set-cookie"]);

    const set = await app.inject({
      method: "PUT",
      url: "/api/user-settings/editor.width",
      headers: { cookie: cookieA },
      payload: { value: "full" },
    });
    expect(set.statusCode).toBe(204);

    const readA = await app.inject({ method: "GET", url: "/api/user-settings", headers: { cookie: cookieA } });
    expect(JSON.parse(readA.body)["editor.width"]).toBe("full");

    const signupB = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "settingsuser2@example.com", password: "correct-horse-battery-staple", name: "SU2" },
    });
    const cookieB = extractCookie(signupB.headers["set-cookie"]);
    const readB = await app.inject({ method: "GET", url: "/api/user-settings", headers: { cookie: cookieB } });
    expect(JSON.parse(readB.body)["editor.width"]).toBeUndefined();
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/user-settings" });
    expect(res.statusCode).toBe(401);
  });
});

describe("file upload size limits - regression test for a real bug (default 1MB Fastify body limit silently rejected real photos)", () => {
  it("a realistic 2MB photo uploads successfully", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "uploadsize@example.com", password: "correct-horse-battery-staple", name: "US" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);
    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "S" } });
    const spaceId = JSON.parse(space.body).id;
    const page = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "p", spaceId, parentBranchId: null },
    });
    const { branchId } = JSON.parse(page.body);

    const { randomBytes } = await import("node:crypto");
    const boundary = "----testboundary";
    const fileData = randomBytes(2 * 1024 * 1024); // 2MB - previously failed with a bare 500 at the 1MB default
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      fileData,
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

  it("a file genuinely too large (30MB) fails cleanly with 413, not a bare 500", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "uploadsize2@example.com", password: "correct-horse-battery-staple", name: "US2" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);
    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "S2" } });
    const spaceId = JSON.parse(space.body).id;
    const page = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "p2", spaceId, parentBranchId: null },
    });
    const { branchId } = JSON.parse(page.body);

    const { randomBytes } = await import("node:crypto");
    const boundary = "----testboundary2";
    const fileData = randomBytes(30 * 1024 * 1024);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/files`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error).toContain("too large");
  });
});

describe("nested page creation - regression test for a reported gap (frontend never exposed parentBranchId)", () => {
  it("supports the exact reported scenario: home-lab -> proxmox-test -> test-scripts -> system-scripts", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "nesting@example.com", password: "correct-horse-battery-staple", name: "Nest" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);
    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Home Lab" } });
    const spaceId = JSON.parse(space.body).id;

    const level1 = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "proxmox-test", spaceId, parentBranchId: null },
    });
    expect(level1.statusCode).toBe(201);
    const level1BranchId = JSON.parse(level1.body).branchId;

    const level2 = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "test-scripts", spaceId, parentBranchId: level1BranchId },
    });
    expect(level2.statusCode).toBe(201);
    const level2BranchId = JSON.parse(level2.body).branchId;

    const level3 = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "system-scripts", spaceId, parentBranchId: level2BranchId },
    });
    expect(level3.statusCode).toBe(201);

    // Confirm the tree endpoint (what the UI actually renders) reflects the
    // full three-level nesting correctly, not just that creation succeeded.
    const tree = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/tree`, headers: { cookie } });
    const nodes = JSON.parse(tree.body);
    const root = nodes.find((n: any) => n.slug === "proxmox-test");
    expect(root).toBeDefined();
    expect(root.children[0].slug).toBe("test-scripts");
    expect(root.children[0].children[0].slug).toBe("system-scripts");
  });
});

describe("content validity across every page-creation path - closes the gap that let the empty-document bug through", () => {
  it("a plain page (no template) always has at least one block node", async () => {
    const { cookie } = await (async () => {
      const s = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: { email: "content1@example.com", password: "correct-horse-battery-staple", name: "C1" },
      });
      return { cookie: extractCookie(s.headers["set-cookie"]) };
    })();
    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "S" } });
    const spaceId = JSON.parse(space.body).id;
    const page = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "plain", spaceId, parentBranchId: null },
    });
    const { branchId } = JSON.parse(page.body);
    const fetched = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    const { content } = JSON.parse(fetched.body);
    expect(content.type).toBe("doc");
    expect(Array.isArray(content.content)).toBe(true);
    expect(content.content.length).toBeGreaterThan(0);
  });

  it("a template-seeded page also always has at least one block node", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "content2@example.com", password: "correct-horse-battery-staple", name: "C2" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);
    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "S2" } });
    const spaceId = JSON.parse(space.body).id;

    // Source page with real content, saved via the normal flow.
    const source = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "source", spaceId, parentBranchId: null },
    });
    const { pageId: sourcePageId, branchId: sourceBranchId } = JSON.parse(source.body);
    const fetchedSource = await app.inject({ method: "GET", url: `/api/branches/${sourceBranchId}/page`, headers: { cookie } });
    const { updatedAt } = JSON.parse(fetchedSource.body);
    await app.inject({
      method: "PUT",
      url: `/api/pages/${sourcePageId}/branches/${sourceBranchId}`,
      headers: { cookie },
      payload: {
        content: { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Template" }] }] },
        expectedUpdatedAt: updatedAt,
      },
    });

    const template = await app.inject({
      method: "POST",
      url: "/api/templates",
      headers: { cookie },
      payload: { pageId: sourcePageId, sourceBranchId, name: "T", scope: "user" },
    });
    const templateId = JSON.parse(template.body).id;

    const seeded = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "from-template", spaceId, parentBranchId: null, templateId },
    });
    const { branchId: seededBranchId } = JSON.parse(seeded.body);
    const fetchedSeeded = await app.inject({ method: "GET", url: `/api/branches/${seededBranchId}/page`, headers: { cookie } });
    const { content } = JSON.parse(fetchedSeeded.body);
    expect(content.content.length).toBeGreaterThan(0);
    expect(JSON.stringify(content)).toContain("Template"); // actually copied, not just non-empty
  });
});

describe("account-scope validation on share links", () => {
  it("rejects an account-scoped share link with a clean 400 (structural rule from brief §3.10)", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "scopecheck@example.com", password: "correct-horse-battery-staple", name: "Scope" },
    });
    const cookie = extractCookie(signup.headers["set-cookie"]);
    const space = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "S" } });
    const spaceId = JSON.parse(space.body).id;
    const page = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie },
      payload: { slug: "p", spaceId, parentBranchId: null },
    });
    const { branchId } = JSON.parse(page.body);

    const res = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/share-links`,
      headers: { cookie },
      payload: { scopeType: "account", scopeId: "x", permission: "view", expiresAt: "2027-01-01T00:00:00Z" },
    });
    expect(res.statusCode).toBe(400);
  });
});
