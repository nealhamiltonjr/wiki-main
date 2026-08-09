import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Slice-8 gate (brief §3.2 / §7.12d.2): FTS5 search with the snippet-escaping
// fix. The old app had a real stored-XSS bug here: snippet() output was sent to
// the client raw and rendered via dangerouslySetInnerHTML, so a page whose body
// contained `<script>` (or even a literal `<mark>` breaking the highlight
// markup) executed as HTML. v2 escapes every character of page text before it
// reaches the client, while keeping the real highlight markers as `<mark>`.
// Env vars MUST be set before the app module is imported.
const DB_PATH = `data/test-search-${randomBytes(4).toString("hex")}.db`;

process.env.DB_PATH = DB_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;

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
    payload: { name: "S", email, password: "correct-horse-battery-staple" },
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

async function savePage(cookie: string, branchId: string, content: unknown) {
  const current = await app.inject({ method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie } });
  const { updatedAt } = current.json();
  return app.inject({
    method: "PUT",
    url: `/api/branches/${branchId}/page/content`,
    headers: { cookie },
    payload: { content, expectedUpdatedAt: updatedAt },
  });
}

async function search(cookie: string, q: string) {
  const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as { results: { slug: string; snippet: string; title: string; spaceName: string }[]; spaces: { id: string; name: string; pageCount: number }[]; count: number };
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  // Reset singletons from a previous test file (vitest runs sequentially).
  const { closeDb } = await import("../db/index.js");
  const { resetAuth } = await import("../auth/config.js");
  closeDb();
  resetAuth();

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const { closeDb } = await import("../db/index.js");
  const { resetAuth } = await import("../auth/config.js");
  closeDb();
  resetAuth();
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe("search (§7.12d.2)", () => {
  it("indexes on save and returns FTS results", async () => {
    const { cookie } = await signup(`search-a-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "SRCH");
    const { pageId, branchId } = await createPage(cookie, spaceId, "alpine-guide");

    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Alpine Guide" }] },
        { type: "paragraph", content: [{ type: "text", text: "How to climb Mt. Rainier safely with crampons and ice axe." }] },
      ],
    };
    await savePage(cookie, branchId, doc);

    const r1 = await search(cookie, "crampons");
    expect(r1.results.length).toBeGreaterThanOrEqual(1);
    const match = r1.results.find((r) => r.slug === "alpine-guide")!;
    expect(match).toBeDefined();
    expect(match.snippet).toMatch(/crampons/i);

    // Nonexistent term → no results.
    const r2 = await search(cookie, "xyzzy");
    expect(r2.results).toHaveLength(0);
    void pageId;
  });

  it("finds partial and stemmed words via prefix + porter", async () => {
    const { cookie } = await signup(`search-b-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "SRCH");
    const { branchId } = await createPage(cookie, spaceId, "linux-notes");

    await savePage(cookie, branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "The Linux networking codebase lives under net/." }] }],
    });

    const r1 = await search(cookie, "net");
    expect(r1.results.some((r) => r.slug === "linux-notes")).toBe(true);

    const r2 = await search(cookie, "linux network code");
    expect(r2.results.some((r) => r.slug === "linux-notes")).toBe(true);

    const r3 = await search(cookie, "code");
    expect(r3.results.some((r) => r.slug === "linux-notes")).toBe(true);

    // Quoted phrase requires adjacency.
    const r4 = await search(cookie, '"linux code"');
    expect(r4.results.some((r) => r.slug === "linux-notes")).toBe(false);
  });

  it("advanced query syntax: AND, quoted phrase, OR, exclusion", async () => {
    const { cookie } = await signup(`search-c-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "ADV");

    const lr = await createPage(cookie, spaceId, "linux-code-review");
    await savePage(cookie, lr.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Our team runs linux code review sessions every Friday." }] }],
    });
    const lo = await createPage(cookie, spaceId, "linux-only");
    await savePage(cookie, lo.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Just a page about linux, no review content here." }] }],
    });
    const bsd = await createPage(cookie, spaceId, "bsd-notes");
    await savePage(cookie, bsd.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Notes about bsd systems." }] }],
    });
    const dep = await createPage(cookie, spaceId, "linux-deprecated");
    await savePage(cookie, dep.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "This linux howto is deprecated, do not use." }] }],
    });

    const and = await search(cookie, "linux code review");
    const andSlugs = and.results.map((r) => r.slug);
    expect(andSlugs).toContain("linux-code-review");
    expect(andSlugs).not.toContain("linux-only");

    const phrase = await search(cookie, '"code review"');
    expect(phrase.results.some((r) => r.slug === "linux-code-review")).toBe(true);

    const or = await search(cookie, "bsd OR linux-only");
    const orSlugs = or.results.map((r) => r.slug);
    expect(orSlugs).toContain("bsd-notes");
    expect(orSlugs).toContain("linux-only");

    const exclude = await search(cookie, "linux -deprecated");
    const excludeSlugs = exclude.results.map((r) => r.slug);
    expect(excludeSlugs).toContain("linux-only");
    expect(excludeSlugs).not.toContain("linux-deprecated");
  });

  it("returns spaces alongside pages, with page counts and space names", async () => {
    const { cookie } = await signup(`search-d-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "Linux Laptop");
    const { branchId } = await createPage(cookie, spaceId, "arch-install");
    await savePage(cookie, branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Linux dual-boot setup steps for a ThinkPad." }] }],
    });

    const r = await search(cookie, "linux");
    const space = r.spaces.find((s) => s.id === spaceId);
    expect(space).toBeDefined();
    expect(space!.name).toBe("Linux Laptop");
    expect(space!.pageCount).toBeGreaterThanOrEqual(1);
    expect(r.results.some((p) => p.slug === "arch-install" && p.spaceName === "Linux Laptop")).toBe(true);
  });

  it("returns empty for an empty query", async () => {
    const { cookie } = await signup(`search-e-${randomBytes(4).toString("hex")}@example.com`);
    const res = await app.inject({ method: "GET", url: "/api/search?q=", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(0);
    expect(res.json().spaces).toHaveLength(0);
  });

  it("SNIPPET-XSS: a page body containing <script> is escaped, never emitted as HTML", async () => {
    const { cookie } = await signup(`search-xss-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "XSS");
    const { branchId } = await createPage(cookie, spaceId, "xss-page");

    // The script is in a plain text node, so it IS part of the FTS body and
    // snippet(). The regression is that the client would render it as HTML.
    await savePage(cookie, branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: 'vulnerable payload <script>alert(1)</script> inside body text' }] }],
    });

    const r = await search(cookie, "payload");
    const match = r.results.find((x) => x.slug === "xss-page")!;
    expect(match).toBeDefined();
    // Raw page text is escaped...
    expect(match.snippet).toContain("&lt;script&gt;");
    expect(match.snippet).not.toContain("<script>");
    expect(match.snippet).not.toContain("</script>");
    // ...but the real highlight marker survives as a <mark> tag.
    expect(match.snippet).toMatch(/<mark>payload<\/mark>/);
  });

  it("SNIPPET-XSS: a literal '<mark>' in page text is escaped, so users can't forge highlight boundaries", async () => {
    const { cookie } = await signup(`search-mark-${randomBytes(4).toString("hex")}@example.com`);
    const spaceId = await createSpace(cookie, "MARK");
    const { branchId } = await createPage(cookie, spaceId, "mark-page");

    // Page text that itself contains the highlight marker strings.
    await savePage(cookie, branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "<mark>forged</mark> genuine needle around it" }] }],
    });

    const r = await search(cookie, "needle");
    const match = r.results.find((x) => x.slug === "mark-page")!;
    expect(match).toBeDefined();
    // The forged marker text in the page body is escaped...
    expect(match.snippet).toContain("&lt;mark&gt;forged&lt;/mark&gt;");
    expect(match.snippet).not.toContain("<mark>forged</mark>");
    // ...and exactly ONE real highlight around the matched term.
    expect(match.snippet).toMatch(/<mark>needle<\/mark>/);
  });

  it("filters results by permission - a non-member never sees another space's matches", async () => {
    const ownerEmail = `search-owner-${randomBytes(4).toString("hex")}@example.com`;
    const outsiderEmail = `search-outsider-${randomBytes(4).toString("hex")}@example.com`;
    const owner = await signup(ownerEmail);
    const outsider = await signup(outsiderEmail);

    const privateSpace = await createSpace(owner.cookie, "Private Linux Space");
    const memberSpace = await createSpace(owner.cookie, "Shared Linux Space");

    const { getDb } = await import("../db/index.js");
    const { users, spaceMembers } = await import("../db/schema.js");
    const [outsiderRow] = await getDb().db.select({ id: users.id }).from(users).where(eq(users.email, outsiderEmail));
    await getDb().db.insert(spaceMembers).values({ spaceId: memberSpace, userId: outsiderRow!.id, role: "viewer" });

    const secret = await createPage(owner.cookie, privateSpace, "secret-linux-runbook");
    await savePage(owner.cookie, secret.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "linux runbook only the owner should be able to find" }] }],
    });
    const shared = await createPage(owner.cookie, memberSpace, "shared-linux-runbook");
    await savePage(owner.cookie, shared.branchId, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "linux runbook the outsider IS a member for" }] }],
    });

    const ownerRes = await search(owner.cookie, "linux");
    const ownerSlugs = ownerRes.results.map((r) => r.slug);
    expect(ownerSlugs).toContain("secret-linux-runbook");
    expect(ownerSlugs).toContain("shared-linux-runbook");
    expect(ownerRes.spaces.some((s) => s.id === privateSpace)).toBe(true);

    const outsiderRes = await search(outsider.cookie, "linux");
    const outsiderSlugs = outsiderRes.results.map((r) => r.slug);
    expect(outsiderSlugs).toContain("shared-linux-runbook");
    expect(outsiderSlugs).not.toContain("secret-linux-runbook");
    expect(outsiderRes.results.some((r) => /secret/i.test(r.snippet) || /secret/i.test(r.title))).toBe(false);
    expect(outsiderRes.spaces.some((s) => s.id === privateSpace)).toBe(false);
    expect(outsiderRes.spaces.some((s) => s.id === memberSpace)).toBe(true);
  });
});
