import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const TEST_DB_PATH = "./data/test-title.db";
const TEST_REPO_ROOT = "./data/test-title-repo";
const TEST_FILES_ROOT = "./data/test-title-files";
process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = "tt-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = "tt-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
let pageId: string;
let branchId: string;

async function createPage(opts: { slug: string; title?: string; parentBranchId?: string | null }) {
  const res = await app.inject({
    method: "POST",
    url: "/api/pages",
    headers: { cookie },
    payload: { slug: opts.slug, title: opts.title, spaceId, parentBranchId: opts.parentBranchId ?? null },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { pageId: string; branchId: string };
}

// Mirrors the real client: fetches the current content + updatedAt, then PUTs
// them back (optionally with a new title). A title-only save echoes the current
// content unchanged - which is how the server detects "no body change" and
// skips the OCC window.
async function save(opts: { pageId: string; branchId: string; content?: unknown; title?: string }) {
  const get = await app.inject({ method: "GET", url: `/api/branches/${opts.branchId}/page`, headers: { cookie } });
  const current = JSON.parse(get.body);
  const res = await app.inject({
    method: "PUT",
    url: `/api/pages/${opts.pageId}/branches/${opts.branchId}`,
    headers: { cookie },
    payload: { title: opts.title, content: opts.content ?? current.content, expectedUpdatedAt: current.updatedAt },
  });
  expect(res.statusCode).toBe(200);
}

const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };

beforeAll(async () => {
  cookie = await signupAsAdmin("title-alice@example.com");
  spaceId = await createSpace(cookie, "Titles");
  const p = await createPage({ slug: "title-page" });
  pageId = p.pageId;
  branchId = p.branchId;
});

async function signupAsAdmin(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/sign-up/email", payload: { email, password: "pw-" + email, name: "Admin" } });
  return extractCookie(res.headers["set-cookie"]);
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  return JSON.parse(res.body).id as string;
}

describe("title column (UI overhaul Track A)", () => {
  it("defaults the title to the slug when created without one", async () => {
    const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe("title-page");
  });

  it("stores an explicit title on create", async () => {
    const p = await createPage({ slug: "titled-page", title: "Explicit Title" });
    const res = await app.inject({ method: "GET", url: `/api/branches/${p.branchId}/page`, headers: { cookie } });
    expect(JSON.parse(res.body).title).toBe("Explicit Title");
  });

  it("updates the title via save with an explicit title", async () => {
    await save({ pageId, branchId, content: emptyDoc, title: "Renamed Via Save" });
    const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    expect(JSON.parse(res.body).title).toBe("Renamed Via Save");
  });

  it("falls back to the first body H1 when no explicit title is sent", async () => {
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Heading Title" }] },
        { type: "paragraph", content: [{ type: "text", text: "body" }] },
      ],
    };
    await save({ pageId, branchId, content });
    const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    expect(JSON.parse(res.body).title).toBe("Heading Title");
  });

  it("keeps the previous title when a body save has no H1 and no explicit title", async () => {
    // Leave the previous "Heading Title" in place, then save plain body content.
    await save({ pageId, branchId, content: emptyDoc });
    const res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    expect(JSON.parse(res.body).title).toBe("Heading Title");
  });

  it("saving only a title does not conflict with a concurrent body save (title not in the OCC window)", async () => {
    const p = await createPage({ slug: "occ-page" });

    // Fetch the current content + timestamp, like the real client does before
    // a title-only save.
    const get = await app.inject({ method: "GET", url: `/api/branches/${p.branchId}/page`, headers: { cookie } });
    const current = JSON.parse(get.body);
    const updatedAt = current.updatedAt as string;

    // A title-only save echoes the current content: it must not conflict, and
    // must not bump updatedAt so the body save's expectedUpdatedAt still matches.
    const titleRes = await app.inject({
      method: "PUT",
      url: `/api/pages/${p.pageId}/branches/${p.branchId}`,
      headers: { cookie },
      payload: { title: "OCC Title", content: current.content, expectedUpdatedAt: updatedAt },
    });
    expect(titleRes.statusCode).toBe(200);

    const get2 = await app.inject({ method: "GET", url: `/api/branches/${p.branchId}/page`, headers: { cookie } });
    expect(JSON.parse(get2.body).title).toBe("OCC Title");
    // updatedAt should be unchanged by a title-only save (title update is
    // applied without bumping the timestamp).
    expect(JSON.parse(get2.body).updatedAt).toBe(updatedAt);

    // A body save using the PRE-title timestamp must therefore still succeed:
    // the title update didn't consume the OCC window. Use DIFFERENT content so
    // the OCC gate actually runs.
    const changedDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "changed" }] }] };
    const bodyRes = await app.inject({
      method: "PUT",
      url: `/api/pages/${p.pageId}/branches/${p.branchId}`,
      headers: { cookie },
      payload: { content: changedDoc, expectedUpdatedAt: updatedAt },
    });
    expect(bodyRes.statusCode).toBe(200);
  });

  it("applies a title save even when the body's OCC timestamp is stale", async () => {
    const p = await createPage({ slug: "stale-page" });

    const get = await app.inject({ method: "GET", url: `/api/branches/${p.branchId}/page`, headers: { cookie } });
    const updatedAt = JSON.parse(get.body).updatedAt as string;

    // Simulate a concurrent body save that bumps updatedAt past our title save's
    // timestamp.
    const changedDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "concurrent" }] }] };
    const bodySave = await app.inject({
      method: "PUT",
      url: `/api/pages/${p.pageId}/branches/${p.branchId}`,
      headers: { cookie },
      payload: { content: changedDoc, expectedUpdatedAt: updatedAt },
    });
    expect(bodySave.statusCode).toBe(200);

    // The title save echoes the CURRENT (post-body-save) content but uses the
    // stale pre-body-save timestamp. The body is unchanged, so the title update
    // is applied without an OCC conflict.
    const after = await app.inject({ method: "GET", url: `/api/branches/${p.branchId}/page`, headers: { cookie } });
    const current = JSON.parse(after.body);
    const titleRes = await app.inject({
      method: "PUT",
      url: `/api/pages/${p.pageId}/branches/${p.branchId}`,
      headers: { cookie },
      payload: { title: "Stale Title", content: current.content, expectedUpdatedAt: updatedAt },
    });
    expect(titleRes.statusCode).toBe(200);

    const final = await app.inject({ method: "GET", url: `/api/branches/${p.branchId}/page`, headers: { cookie } });
    expect(JSON.parse(final.body).title).toBe("Stale Title");
  });
});
