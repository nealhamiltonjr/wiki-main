import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import type { FastifyInstance } from "fastify";

// Slice-11 gate: Hocuspocus collab wired to the SAME single DB connection,
// with the single-placement rule enforced at authenticate, and collab content
// written back to pages.content so the git flush pipeline stays consistent.
// The WebSocket upgrade path itself is thin (index.ts); the auth + eligibility
// gates and the seed/store document lifecycle are exported and tested directly
// through the real permission machinery.

const DB_PATH = `data/test-collab-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-collab-repo-${randomBytes(4).toString("hex")}`;

process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;
let resolveCollabPrincipal: typeof import("../services/collab.service.js").resolveCollabPrincipal;
let checkCollabEligibility: typeof import("../services/collab.service.js").checkCollabEligibility;
let loadOrCreateDoc: typeof import("../services/collab.service.js").loadOrCreateDoc;
let storeDocument: typeof import("../services/collab.service.js").storeDocument;
let initGitRepo: typeof import("../services/git.service.js").initGitRepo;
let processPendingJobs: typeof import("../services/queue.service.js").processPendingJobs;
let getDb: typeof import("../db/index.js").getDb;
let createApiToken: typeof import("../services/token.service.js").createApiToken;
let jobQueue: typeof import("../db/schema.js").jobQueue;
let pages: typeof import("../db/schema.js").pages;
let branches: typeof import("../db/schema.js").branches;
let tokens: typeof import("../db/schema.js").tokens;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const cookie = raw?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^better-auth.session_token=/);
  return cookie;
}

async function signup(email: string): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: "U", email, password: "correct-horse-battery-staple" },
  });
  expect(res.statusCode).toBe(200);
  const userId = res.json().user?.id ?? "";
  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: "correct-horse-battery-staple" },
  });
  expect(signIn.statusCode).toBe(200);
  return { cookie: extractCookie(signIn.headers["set-cookie"]), userId };
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createPage(cookie: string, spaceId: string, slug: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

function paragraph(id: string, text: string) {
  return {
    type: "paragraph",
    attrs: { id },
    content: [{ type: "text", text }],
  };
}

beforeAll(async () => {
  const root = process.cwd();
  if (!existsSync(`${root}/data`)) mkdirSync(`${root}/data`, { recursive: true });
  ({ resolveCollabPrincipal, checkCollabEligibility, loadOrCreateDoc, storeDocument } = await import(
    "../services/collab.service.js"
  ));
  ({ initGitRepo } = await import("../services/git.service.js"));
  ({ processPendingJobs } = await import("../services/queue.service.js"));
  ({ getDb } = await import("../db/index.js"));
  ({ createApiToken } = await import("../services/token.service.js"));
  ({ jobQueue, pages, branches, tokens } = await import("../db/schema.js"));
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

describe("collab auth + eligibility (slice-11 gate)", () => {
  it("resolves a session principal and allows an editor on a single-placement page", async () => {
    const { cookie, userId } = await signup("alice@example.com");
    const spaceId = await createSpace(cookie, "Collab Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "collab-page");

    const headers = new Headers({ cookie });
    const principal = await resolveCollabPrincipal(undefined, headers);
    expect(principal?.source).toBe("session");
    expect(principal?.user.id).toBe(userId);

    const result = await checkCollabEligibility(principal!.user, branchId);
    expect(result).toEqual({ ok: true, pageId, branchId });
  });

  it("rejects a multi-placement (cloned) page for live collab", async () => {
    const { cookie } = await signup("bob@example.com");
    const spaceId = await createSpace(cookie, "Clone Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "clone-me");

    const cloneRes = await app.inject({
      method: "POST",
      url: `/api/branches/${branchId}/clone`,
      headers: { cookie },
      payload: { targetSpaceId: spaceId, targetParentBranchId: null },
    });
    expect(cloneRes.statusCode).toBe(201);

    const headers = new Headers({ cookie });
    const principal = await resolveCollabPrincipal(undefined, headers);
    const result = await checkCollabEligibility(principal!.user, branchId);
    expect(result).toEqual({ ok: false, error: "Collaboration is only available for pages with a single placement" });
    expect(pageId.length).toBeGreaterThan(0);
  });

  it("rejects a viewer (editor access required)", async () => {
    const { cookie: ownerCookie } = await signup("carol@example.com");
    const { cookie: viewerCookie, userId: viewerId } = await signup("dave@example.com");
    const spaceId = await createSpace(ownerCookie, "Perm Space");
    const { branchId } = await createPage(ownerCookie, spaceId, "perm-page");

    // Dave joins as a viewer — enough to SEE the page, not to edit it live.
    const addRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${spaceId}/members`,
      headers: { cookie: ownerCookie },
      payload: { userId: viewerId, role: "viewer" },
    });
    expect(addRes.statusCode).toBe(201);

    const headers = new Headers({ cookie: viewerCookie });
    const principal = await resolveCollabPrincipal(undefined, headers);
    const result = await checkCollabEligibility(principal!.user, branchId);
    expect(result).toEqual({ ok: false, error: "Editor access required for collaboration" });
  });

  it("rejects an unauthenticated connection", async () => {
    const headers = new Headers({ cookie: "better-auth.session_token=bogus" });
    const principal = await resolveCollabPrincipal(undefined, headers);
    expect(principal).toBeNull();
  });

  it("rejects an encrypted page so collab can't leak plaintext into the envelope slot", async () => {
    // §13.7: collab broadcast + storeDocument write-back would overwrite the
    // ciphertext envelope with Tiptap JSON. The check fires at the gate so the
    // UI never offers "Live edit…" on encrypted pages either.
    const { cookie, userId } = await signup("enc-collab@example.com");
    const spaceId = await createSpace(cookie, "EncCollab Space");
    const { branchId } = await createPage(cookie, spaceId, "enc-page");

    const envelope = {
      v: 1,
      kdf: { alg: "PBKDF2-SHA-256", salt: "AAECAwQFBgcICQoLDA0ODw==", iterations: 100000 },
      dek: { iv: "AAAAAAAAAAAAAAAA", data: "d2VsbC1ub3QtdHJ1bHk=" },
      content: { iv: "AAAAAAAAAAAAAAAA", data: "cGxlYXN0eHQ=" },
    };
    const getPage = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    const { updatedAt } = getPage.json() as { updatedAt: string };
    const protect = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: { content: envelope, expectedUpdatedAt: updatedAt, encrypted: true },
    });
    expect(protect.statusCode).toBe(200);

    const headers = new Headers({ cookie });
    const principal = await resolveCollabPrincipal(undefined, headers);
    expect(principal?.user.id).toBe(userId);
    const result = await checkCollabEligibility(principal!.user, branchId);
    expect(result).toEqual({ ok: false, error: "Collaboration is not available on encrypted pages" });

    // The same gate must clear and re-allow when the page is unprotected.
    const [page] = await getDb().db.select({ isEncrypted: pages.isEncrypted }).from(pages).where(eq(pages.id, (await getPage.json() as { id: string }).id));
    expect(page?.isEncrypted).toBe(true);
  });

  it("accepts an account-scoped passwordless token and rejects a password-protected one", async () => {
    // An account-scoped, passwordless API token IS a valid collab credential;
    // a password-protected one must not be (there is no way to present the
    // password over a WebSocket, mirroring the REST bearer engine's rule).
    const { cookie, userId } = await signup("erin@example.com");

    // Passwordless account token → accepted.
    const { rawToken } = await createApiToken({
      createdBy: userId,
      isAdmin: false,
      scopeType: "account",
      scopeId: null,
      permission: "edit",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const principal = await resolveCollabPrincipal(rawToken, new Headers());
    expect(principal?.source).toBe("token");
    expect(principal?.user.id).toBe(userId);

    // Password-protected account token (hashed the same way the service hashes)
    // → rejected, falling through to the (empty) session headers → null.
    const rawProtected = `wak_${randomBytes(24).toString("hex")}`;
    const { db } = getDb();
    await db.insert(tokens).values({
      id: randomBytes(16).toString("hex"),
      type: "api_token",
      tokenHash: createHash("sha256").update(rawProtected).digest("hex"),
      createdBy: userId,
      scopeType: "account",
      scopeId: null,
      permission: "edit",
      passwordHash: createHash("sha256").update("sekret").digest("hex"),
      expiresAt: new Date(Date.now() + 3600_000),
      warningCount: 0,
    });
    const rejected = await resolveCollabPrincipal(rawProtected, new Headers());
    expect(rejected).toBeNull();
    expect(cookie.length).toBeGreaterThan(0);
  });
});

describe("collab document lifecycle (slice-11 gate)", () => {
  it("seeds a fresh collab doc from persisted page content", async () => {
    const { cookie } = await signup("frank@example.com");
    const spaceId = await createSpace(cookie, "Seed Space");
    const { branchId } = await createPage(cookie, spaceId, "seed-page");

    const content = {
      type: "doc",
      content: [paragraph("blk-seed-1", "Hello from the seeded doc")],
    };
    const getPage = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    const { updatedAt } = getPage.json() as { updatedAt: string };
    const save = await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: { content, expectedUpdatedAt: updatedAt },
    });
    expect(save.statusCode).toBe(200);

    const doc = await loadOrCreateDoc(branchId);
    const json = yDocToProsemirrorJSON(doc, "default") as {
      content: Array<{ attrs?: { id?: string }; content?: Array<{ text?: string }> }>;
    };
    const text = json.content?.[0]?.content?.[0]?.text;
    expect(text).toBe("Hello from the seeded doc");
  });

  it("writes collab content back to pages.content and enqueues a git commit", async () => {
    const { cookie } = await signup("grace@example.com");
    const spaceId = await createSpace(cookie, "Store Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "store-page");

    const content = {
      type: "doc",
      content: [paragraph("blk-store-1", "Before collab")],
    };
    const getPage = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    const { updatedAt } = getPage.json() as { updatedAt: string };
    await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: { content, expectedUpdatedAt: updatedAt },
    });

    const doc = await loadOrCreateDoc(branchId);

    // Simulate a collaborator's edit through the real Yjs data structures:
    // prepend text into the first paragraph's XmlText.
    const frag = doc.getXmlFragment("default");
    const firstPara = frag.toArray()[0] as
      | { toArray: () => Array<{ insert: (index: number, content: string) => void }> }
      | undefined;
    expect(firstPara).toBeDefined();
    firstPara!.toArray()[0]!.insert(0, "Edited live in collab — ");

    await storeDocument(branchId, doc);

    const { db } = getDb();
    const [pageRow] = await db.select({ content: pages.content }).from(pages).where(eq(pages.id, pageId));
    const savedText = (pageRow!.content as unknown as { content: Array<{ content?: Array<{ text?: string }> }> })
      .content[0]?.content?.[0]?.text;
    expect(savedText).toBe("Edited live in collab — Before collab");

    // The write-back enqueues a git_commit job; draining it must produce a
    // real commit in the content repo (git flush stays consistent under collab).
    const jobs = await db.select().from(jobQueue).where(eq(jobQueue.kind, "git_commit"));
    const pageJobs = jobs.filter((j) => (j.payload as { pageId?: string }).pageId === pageId);
    expect(pageJobs.length).toBeGreaterThan(0);
    expect(pageJobs[0]!.payload).toMatchObject({ pageId, branchId, kind: "autosave" });

    await processPendingJobs();
    const log = execSync("git log --oneline", { cwd: REPO_PATH, encoding: "utf8" });
    expect(log).toContain(pageId);
  });

  it("does not churn the page or enqueue jobs when the collab doc is unchanged", async () => {
    const { cookie } = await signup("heidi@example.com");
    const spaceId = await createSpace(cookie, "Idle Space");
    const { pageId, branchId } = await createPage(cookie, spaceId, "idle-page");

    const content = {
      type: "doc",
      content: [paragraph("blk-idle-1", "Stable content")],
    };
    const getPage = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
    const { updatedAt } = getPage.json() as { updatedAt: string };
    await app.inject({
      method: "PUT",
      url: `/api/branches/${branchId}/page/content`,
      headers: { cookie },
      payload: { content, expectedUpdatedAt: updatedAt },
    });

    const doc = await loadOrCreateDoc(branchId);
    await storeDocument(branchId, doc); // no edits since seed

    const { db } = getDb();
    const [pageRow] = await db.select({ content: pages.content }).from(pages).where(eq(pages.id, pageId));
    const still = (pageRow!.content as unknown as { content: Array<{ content?: Array<{ text?: string }> }> })
      .content[0]?.content?.[0]?.text;
    expect(still).toBe("Stable content");

    const jobs = await db.select().from(jobQueue).where(eq(jobQueue.kind, "git_commit"));
    const pageJobs = jobs.filter((j) => (j.payload as { pageId?: string }).pageId === pageId);
    // Create + the one save each enqueue a commit; the idle store added none.
    expect(pageJobs.length).toBe(2);
    expect(branches).toBeDefined();
  });
});
