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

  it("a no-op save (title-only, unchanged content) does not fail the commit job", async () => {
    const cookie = await signup("flush-noop@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Noop Space" } });
    const spaceId = spaceRes.json().id as string;
    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "noop-page" },
    });
    const { pageId, branchId } = pageRes.json() as { pageId: string; branchId: string };
    await processPendingJobs();

    // Read current content + timestamp so the save below reproduces it exactly.
    const readRes = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    const current = readRes.json() as { content: unknown; title: string; updatedAt: string };

    // Title-only save with the SAME title/content: savePageOCC enqueues a
    // commit WITHOUT bumping updatedAt, so the exported file is byte-identical
    // to the last commit. The job must complete (skip the empty commit) rather
    // than retry and fail on git's "nothing to commit".
    const saveRes = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: {
        content: current.content,
        title: current.title,
        titleProvided: true,
        expectedUpdatedAt: current.updatedAt,
      },
    });
    expect(saveRes.statusCode).toBe(200);

    // The one enqueued job completes cleanly (0 would mean it threw).
    expect(await processPendingJobs()).toBe(1);

    // And no spurious second commit exists for the page.
    const log = execSync("git log --oneline --all", { cwd: REPO_PATH, encoding: "utf-8" });
    const commits = log.split("\n").filter((l) => l.includes(`page:${pageId}:`));
    expect(commits.length).toBe(1);
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

  it("rename commits the new slug so the git tree tracks the DB", async () => {
    const cookie = await signup("flush-rename@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Rename Space" } });
    const spaceId = spaceRes.json().id as string;
    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "old-name" },
    });
    const { pageId, branchId } = pageRes.json() as { pageId: string; branchId: string };
    await processPendingJobs();

    // Rename through the real route, then drain the queue.
    const renameRes = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageId}/branches/${branchId}/slug`,
      headers: { cookie },
      payload: { slug: "new-name" },
    });
    expect(renameRes.statusCode).toBe(200);
    await processPendingJobs();

    // The repo must contain the new slug file and a commit naming it, even
    // though no content save happened after the rename.
    const log = execSync("git log --oneline --all", { cwd: REPO_PATH, encoding: "utf-8" });
    expect(log).toContain(`page:${pageId}: Update - new-name`);
    const files = execSync("git ls-tree -r --name-only HEAD", { cwd: REPO_PATH, encoding: "utf-8" });
    expect(files).toContain("rename-space/new-name.md");
    // And the OLD slug file must be gone — the rename commit drops it, so the
    // tree doesn't keep a stale copy of the page under its previous name.
    expect(files).not.toContain("rename-space/old-name.md");
  });

  it("restore rejects a non-hex commitHash instead of passing it to git", async () => {
    const cookie = await signup("flush-badhash@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Hash Space" } });
    const spaceId = spaceRes.json().id as string;
    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "bad-hash" },
    });
    const { pageId, branchId } = pageRes.json() as { pageId: string; branchId: string };
    await processPendingJobs();

    // "--output=/tmp/evil" must never reach a git command as an option.
    const res = await app.inject({
      method: "POST",
      url: `/api/pages/${pageId}/branches/${branchId}/restore`,
      headers: { cookie },
      payload: { commitHash: "--output=/tmp/evil" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects slugs that would escape the repo or inject git options", async () => {
    const cookie = await signup("flush-slug@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Slug Space" } });
    expect(spaceRes.statusCode).toBe(201);
    const spaceId = spaceRes.json().id as string;

    // Path traversal: the slug becomes <space>/<slug>.md on the file system,
    // so "../../../../tmp/evil" would resolve OUTSIDE the content repo.
    for (const evil of [
      "../../../../tmp/evil",
      "..",
      "a/../b",
      "a\\..\\b",
      "-x",
      ".hidden",
      "--output=/tmp/evil",
      "has space",
      "",
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/spaces/${spaceId}/pages`,
        headers: { cookie },
        payload: { slug: evil },
      });
      expect(res.statusCode).toBe(400);
    }

    // The rename route shares the same guard.
    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "fine-slug" },
    });
    expect(pageRes.statusCode).toBe(201);
    const { pageId, branchId } = pageRes.json() as { pageId: string; branchId: string };
    const renameRes = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageId}/branches/${branchId}/slug`,
      headers: { cookie },
      payload: { slug: "../../../../etc/cron.d/evil" },
    });
    expect(renameRes.statusCode).toBe(400);
  });

  it("rejects content with unknown node types (422) instead of flushing it to git", async () => {
    const cookie = await signup("flush-badcontent@example.com");
    const spaceRes = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name: "Bad Content Space" } });
    const spaceId = spaceRes.json().id as string;
    const pageRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/pages`,
      headers: { cookie },
      payload: { slug: "bad-content" },
    });
    const { branchId } = pageRes.json() as { branchId: string };

    const readRes = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    const updatedAt = (readRes.json() as { updatedAt: string }).updatedAt;

    const res = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: {
        content: { type: "doc", content: [{ type: "mysteryNode", attrs: {}, content: [] }] },
        expectedUpdatedAt: updatedAt,
      },
    });
    expect(res.statusCode).toBe(422);

    // The invalid doc must never reach the git tree. Page creation DOES enqueue
    // the initial (empty) commit, so assert on the exported file content rather
    // than the commit list.
    await processPendingJobs();
    const file = execSync("git show HEAD:bad-content-space/bad-content.md", { cwd: REPO_PATH, encoding: "utf-8" });
    expect(file).not.toContain("mysteryNode");
    expect(file).toContain("title:"); // still just the initial frontmatter
  });
});
