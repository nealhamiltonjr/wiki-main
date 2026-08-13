import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-23 gate: a save followed by another save produces two commits in
// the git repo, and GET /api/pages/:pageId/branches/:branchId/diff returns
// a line-level unified diff between them, with title change signal derived
// from the YAML frontmatter.

const DB_PATH = `data/test-diff-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-diff-repo-${randomBytes(4).toString("hex")}`;

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
    rmSync(`${p}-wal`, { force: true });
    rmSync(`${p}-shm`, { force: true });
  }
});

async function signupAndLogin(): Promise<{ userId: string; cookie: string }> {
  const email = `diff-${randomBytes(4).toString("hex")}@test.local`;
  const signUpRes = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: "Diff", email, password: "correct-horse-battery-staple" },
  });
  expect(signUpRes.statusCode).toBe(200);
  // Extract userId from response (better-auth returns user object on signup).
  const cookie = extractCookie(signUpRes.headers["set-cookie"]);
  const userId = signUpRes.json().user.id as string;
  return { userId, cookie };
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/spaces",
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createPage(
  cookie: string,
  spaceId: string,
  slug: string,
  title: string,
  parentBranchId: string | null,
): Promise<{ pageId: string; branchId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug, title, parentBranchId },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function saveContent(
  cookie: string,
  branchId: string,
  content: object,
  title: string,
): Promise<void> {
  // OCC: read the current updatedAt so we always have the latest version.
  const load = await app.inject({
    method: "GET",
    url: `/api/branches/${branchId}/page`,
    headers: { cookie },
  });
  expect(load.statusCode).toBe(200);
  const expectedUpdatedAt = load.json().updatedAt;
  const res = await app.inject({
    method: "PUT",
    url: `/api/branches/${branchId}/page/content`,
    headers: { cookie },
    payload: { content, title, expectedUpdatedAt },
  });
  expect(res.statusCode).toBe(200);
}

async function flush(): Promise<void> {
  await processPendingJobs();
}

async function getHistory(cookie: string, pageId: string, branchId: string): Promise<{ hash: string; message: string }[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/pages/${pageId}/branches/${branchId}/history`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Pick the chronologically-first and chronologically-last commits as from/to.
 * History is returned in reverse-chronological order (newest first), so the
 * first chronological commit lives at the tail. */
function pickFirstLast<T extends { hash: string }>(history: T[]): { from: T; to: T } {
  if (history.length < 2) throw new Error("need at least 2 commits");
  return {
    from: history[history.length - 1]!,
    to: history[0]!,
  };
}

async function getDiff(
  cookie: string,
  pageId: string,
  branchId: string,
  from: string,
  to: string,
): Promise<{
  pageId: string;
  fromHash: string;
  toHash: string;
  titleChanged: boolean;
  fromTitle: string | null;
  toTitle: string | null;
  lines: { type: string; fromLine: number | null; toLine: number | null; text: string }[];
  summary: { added: number; removed: number; context: number };
}> {
  const res = await app.inject({
    method: "GET",
    url: `/api/pages/${pageId}/branches/${branchId}/diff?from=${from}&to=${to}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const emptyDoc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const multiParaDoc = (...lines: string[]) => ({
  type: "doc",
  content: lines.map((l) => ({
    type: "paragraph",
    content: l ? [{ type: "text", text: l }] : [],
  })),
});

describe("revision diff (brief §12.3)", () => {
  it("reports an empty diff between identical revisions (from === to)", async () => {
    const { cookie } = await signupAndLogin();
    const spaceId = await createSpace(cookie, "Diff Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "diff-page", "Diff Page", null);

    await saveContent(cookie, branchId, emptyDoc("Same content"), "Diff Page");
    await flush();

    const history = await getHistory(cookie, pageId, branchId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    const same = history[history.length - 1]!;

    // Diff a revision against itself — always empty.
    const diff = await getDiff(cookie, pageId, branchId, same.hash, same.hash);
    expect(diff.titleChanged).toBe(false);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.lines.every((l) => l.type === "context")).toBe(true);
  });

  it("reports an empty diff when content round-trips to identical file content", async () => {
    // Save A, save B (different), save A-again. The file at commits 1 and 3 is
    // identical, so even though there are 3 commits, the diff shows nothing.
    const { cookie } = await signupAndLogin();
    const spaceId = await createSpace(cookie, "Roundtrip Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "rt-page", "Roundtrip Page", null);

    await saveContent(cookie, branchId, emptyDoc("v1"), "Roundtrip Page");
    await flush();
    await saveContent(cookie, branchId, emptyDoc("v2"), "Roundtrip Page");
    await flush();
    await saveContent(cookie, branchId, emptyDoc("v1"), "Roundtrip Page");
    await flush();

    const history = await getHistory(cookie, pageId, branchId);
    expect(history.length).toBeGreaterThanOrEqual(3);
    const { from, to } = pickFirstLast(history);

    const diff = await getDiff(cookie, pageId, branchId, from.hash, to.hash);
    expect(diff.titleChanged).toBe(false);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
  });

  it("captures added lines on a content edit", async () => {
    const { cookie } = await signupAndLogin();
    const spaceId = await createSpace(cookie, "Add Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "add-page", "Add Page", null);

    await saveContent(cookie, branchId, multiParaDoc("Line one"), "Add Page");
    await flush();
    await saveContent(cookie, branchId, multiParaDoc("Line one", "Line two"), "Add Page");
    await flush();

    const history = await getHistory(cookie, pageId, branchId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    const { from, to } = pickFirstLast(history);
    const diff = await getDiff(cookie, pageId, branchId, from.hash, to.hash);

    expect(diff.summary.added).toBeGreaterThan(0);
    expect(diff.lines.some((l) => l.type === "added" && l.text.includes("Line two"))).toBe(true);
  });

  it("captures removed lines when content shrinks", async () => {
    const { cookie } = await signupAndLogin();
    const spaceId = await createSpace(cookie, "Remove Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "remove-page", "Remove Page", null);

    await saveContent(cookie, branchId, multiParaDoc("Keep", "Drop"), "Remove Page");
    await flush();
    await saveContent(cookie, branchId, multiParaDoc("Keep"), "Remove Page");
    await flush();

    const history = await getHistory(cookie, pageId, branchId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    const { from, to } = pickFirstLast(history);
    const diff = await getDiff(cookie, pageId, branchId, from.hash, to.hash);

    expect(diff.summary.removed).toBeGreaterThan(0);
    expect(diff.lines.some((l) => l.type === "removed" && l.text.includes("Drop"))).toBe(true);
  });

  it("surfaces title changes via the titleChanged signal", async () => {
    const { cookie } = await signupAndLogin();
    const spaceId = await createSpace(cookie, "Title Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "title-page", "Original Title", null);

    await saveContent(cookie, branchId, emptyDoc("body"), "Original Title");
    await flush();
    await saveContent(cookie, branchId, emptyDoc("body"), "New Title");
    await flush();

    const history = await getHistory(cookie, pageId, branchId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    const { from, to } = pickFirstLast(history);
    const diff = await getDiff(cookie, pageId, branchId, from.hash, to.hash);

    expect(diff.titleChanged).toBe(true);
    expect(diff.fromTitle).toBe("Original Title");
    expect(diff.toTitle).toBe("New Title");
    // Body didn't change, so no added/removed lines from the content diff.
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
  });

  it("fromLine/toLine numbers are populated correctly", async () => {
    const { cookie } = await signupAndLogin();
    const spaceId = await createSpace(cookie, "Line Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "line-page", "Line Page", null);

    await saveContent(cookie, branchId, multiParaDoc("first", "second"), "Line Page");
    await flush();
    await saveContent(cookie, branchId, multiParaDoc("first", "second", "third"), "Line Page");
    await flush();

    const history = await getHistory(cookie, pageId, branchId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    const { from, to } = pickFirstLast(history);
    const diff = await getDiff(cookie, pageId, branchId, from.hash, to.hash);

    // The new "third" line should appear as `added` with a toLine > 0 and a null fromLine.
    const third = diff.lines.find((l) => l.type === "added" && l.text.includes("third"));
    expect(third).toBeTruthy();
    expect(third?.fromLine).toBeNull();
    expect(third?.toLine).toBeGreaterThan(0);

    // "first" and "second" should be context lines with both line numbers populated.
    const contextLines = diff.lines.filter((l) => l.type === "context");
    expect(contextLines.every((l) => l.fromLine !== null && l.toLine !== null)).toBe(true);
  });

  it("returns 404 when one of the revisions doesn't exist", async () => {
    const { cookie } = await signupAndLogin();
    const spaceId = await createSpace(cookie, "Missing Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "missing-page", "Missing Page", null);

    await saveContent(cookie, branchId, emptyDoc("body"), "Missing Page");
    await flush();

    const history = await getHistory(cookie, pageId, branchId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    const from = history[history.length - 1]!.hash;

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/branches/${branchId}/diff?from=${from}&to=0000000000000000000000000000000000000000`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("non-members can't read the diff", async () => {
    const { cookie: ownerCookie } = await signupAndLogin();
    const { cookie: outsiderCookie } = await signupAndLogin();
    const spaceId = await createSpace(ownerCookie, "Private Diff Space");
    const { pageId, branchId } = await createPage(ownerCookie, spaceId, "private-diff", "Private", null);

    await saveContent(ownerCookie, branchId, emptyDoc("v1"), "Private");
    await flush();
    await saveContent(ownerCookie, branchId, emptyDoc("v2"), "Private");
    await flush();

    const history = await getHistory(ownerCookie, pageId, branchId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    const { from, to } = pickFirstLast(history);

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${pageId}/branches/${branchId}/diff?from=${from.hash}&to=${to.hash}`,
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});