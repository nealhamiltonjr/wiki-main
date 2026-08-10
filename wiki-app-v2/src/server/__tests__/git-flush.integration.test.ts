import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-10 gate through the REAL route layer: a page save enqueues a git_commit
// job (commit queue), the worker drains it, and `git log` on the content repo
// shows a real commit with the page's id in the message. History read API is
// exercised via GET /api/pages/:pageId/branches/:branchId/history.

const DB_PATH = `data/test-git-flush-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-git-flush-repo-${randomBytes(4).toString("hex")}`;

process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;
let initGitRepo: typeof import("../services/git.service.js").initGitRepo;
let processPendingJobs: typeof import("../services/queue.service.js").processPendingJobs;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const cookie = raw?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^better-auth.session_token=/);
  return cookie;
}

beforeAll(async () => {
  const root = process.cwd();
  if (!existsSync(`${root}/data`)) mkdirSync(`${root}/data`, { recursive: true });
  ({ initGitRepo } = await import("../services/git.service.js"));
  ({ processPendingJobs } = await import("../services/queue.service.js"));
  await initGitRepo();

  const { buildApp } = await import("../app.js");
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  const { closeDb } = await import("../db/index.js");
  closeDb();
  for (const p of [DB_PATH, REPO_PATH]) {
    rmSync(p, { recursive: true, force: true });
  }
});

async function signup(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: "U", email, password: "correct-horse-battery-staple" },
  });
  expect(res.statusCode).toBe(200);
  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: "correct-horse-battery-staple" },
  });
  expect(signIn.statusCode).toBe(200);
  return extractCookie(signIn.headers["set-cookie"]);
}

describe("git flush pipeline (slice-10 gate)", () => {
  it("save → commit queue → git log shows a real commit with the page id", async () => {
    const cookie = await signup("flush@example.com");

    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Flush Space" } });
    expect(spaceRes.statusCode).toBe(201);
    const spaceId = spaceRes.json().id as string;

    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "flush-me" },
    });
    expect(pageRes.statusCode).toBe(201);
    const { pageId, branchId } = pageRes.json() as { pageId: string; branchId: string };

    const readRes = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    expect(readRes.statusCode).toBe(200);
    const updatedAt = (readRes.json() as { updatedAt: string }).updatedAt;

    const saveRes = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: {
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Flushed content" }] }] },
        expectedUpdatedAt: updatedAt,
      },
    });
    expect(saveRes.statusCode).toBe(200);

    // Drain the commit queue (the real worker loop polls on this in production).
    const processed = await processPendingJobs();
    expect(processed).toBeGreaterThanOrEqual(1);

    // SLICE GATE: git log on the content repo shows a commit with the page id.
    const log = execSync("git log --oneline --all", { cwd: REPO_PATH, encoding: "utf-8" });
    expect(log).toContain(`page:${pageId}:`);

    // The exported Markdown file contains the actual saved content.
    const file = execSync("git show HEAD:flush-space/flush-me.md", { cwd: REPO_PATH, encoding: "utf-8" });
    expect(file).toContain("Flushed content");
    expect(file).toContain("title:");
  });

  it("history read API returns the page's commits after the queue drains", async () => {
    const cookie = await signup("flush-history@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "History Space" } });
    const spaceId = spaceRes.json().id as string;
    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "history-page" },
    });
    const { pageId, branchId } = pageRes.json() as { pageId: string; branchId: string };
    await processPendingJobs();

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/branches/${branchId}/history`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const history = res.json() as { hash: string; message: string; date: string }[];
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]?.message).toContain(`page:${pageId}:`);
    expect(history[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("history 404s when the branch does not belong to the page", async () => {
    const cookie = await signup("flush-wrong@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Wrong Space" } });
    const spaceId = spaceRes.json().id as string;
    const pageA = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "page-a" },
    });
    const pageB = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "page-b" },
    });
    const a = pageA.json() as { pageId: string };
    const b = pageB.json() as { pageId: string; branchId: string };

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${a.pageId}/branches/${b.branchId}/history`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("restore reads an older commit's content and saves it as the new version", async () => {
    const cookie = await signup("flush-restore@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Restore Space" } });
    const spaceId = spaceRes.json().id as string;
    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "restore-me" },
    });
    const { pageId, branchId } = pageRes.json() as { pageId: string; branchId: string };
    await processPendingJobs(); // drain the initial autosave

    // Save v1 content.
    let res = await app.inject({
      method: "GET",
      url: `/api/branches/${branchId}/page`,
      headers: { cookie },
    });
    let updatedAt = (res.json() as { updatedAt: string }).updatedAt;
    res = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: {
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Version one" }] }] },
        expectedUpdatedAt: updatedAt,
      },
    });
    expect(res.statusCode).toBe(200);
    await processPendingJobs();

    // Save v2 content.
    res = await app.inject({
      method: "GET",
      url: `/api/branches/${branchId}/page`,
      headers: { cookie },
    });
    updatedAt = (res.json() as { updatedAt: string }).updatedAt;
    res = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: {
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Version two" }] }] },
        expectedUpdatedAt: updatedAt,
      },
    });
    expect(res.statusCode).toBe(200);
    await processPendingJobs();

    const history = (await app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/branches/${branchId}/history`,
      headers: { cookie },
    }).then((r) => r.json())) as { hash: string; message: string }[];
    expect(history.length).toBeGreaterThanOrEqual(2);

    // Find the commit that introduced "Version one": the 2nd-newest is the
    // v1 autosave (newest-first ordering).
    const v1Commit = history[1]!;

    const restoreRes = await app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/branches/${branchId}/restore`,
      headers: { cookie },
      payload: { commitHash: v1Commit.hash },
    });
    expect(restoreRes.statusCode).toBe(200);

    // The restored content is now the live content.
    res = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    const page = res.json() as { content: { type: string; content: unknown[] } };
    const text = JSON.stringify(page.content);
    expect(text).toContain("Version one");

    // Restoring also enqueues a fresh forward-moving commit.
    await processPendingJobs();
    const afterLog = execSync("git log --oneline --all", { cwd: REPO_PATH, encoding: "utf-8" });
    expect(afterLog).toContain(`page:${pageId}:`);
  });

  it("snapshot route enqueues a manual snapshot that appears in git history", async () => {
    const cookie = await signup("flush-snapshot@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Snap Space" } });
    const spaceId = spaceRes.json().id as string;
    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "snap-me" },
    });
    const { pageId, branchId } = pageRes.json() as { pageId: string; branchId: string };
    await processPendingJobs();

    const snapRes = await app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/branches/${branchId}/snapshot`,
      headers: { cookie },
      payload: { message: "pre-deploy checkpoint" },
    });
    expect(snapRes.statusCode).toBe(202);

    await processPendingJobs();
    const history = (await app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/branches/${branchId}/history`,
      headers: { cookie },
    }).then((r) => r.json())) as { message: string }[];
    expect(history.some((h) => h.message.includes("Snapshot: page:"))).toBe(true);

    // The snapshot file lives under _snapshots/.
    const files = execSync("git ls-tree -r --name-only HEAD", { cwd: REPO_PATH, encoding: "utf-8" });
    expect(files).toContain(`_snapshots/${pageId}.md`);
  });
});
