import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-template-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-template-repo-${randomBytes(4).toString("hex")}`;
process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let app: FastifyInstance;

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  const { initGitRepo } = await import("../services/git.service.js");
  await initGitRepo();
  const { buildApp } = await import("../app.js");
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  const { closeDb } = await import("../db/index.js");
  closeDb();
  rmSync(DB_PATH, { force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

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
    payload: { email, password: "test-password-1234", name: email.split("@")[0]! },
  });
  expect(res.statusCode).toBe(200);
  const cookie = extractCookie(res.headers["set-cookie"]);
  const body = res.json() as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

async function createSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createPage(
  cookie: string, spaceId: string, slug: string, title: string,
): Promise<{ pageId: string; branchId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug, title },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

async function addMember(
  cookie: string, spaceId: string, userId: string, role: "viewer" | "editor",
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/members`,
    headers: { cookie },
    payload: { userId, role },
  });
  expect(res.statusCode).toBe(201);
}

async function addRelation(
  cookie: string, fromPageId: string, type: string, toPageId: string, position = 0,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/pages/${fromPageId}/relations`,
    headers: { cookie },
    payload: { type, toPageId, position },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function addAttribute(
  cookie: string, pageId: string, name: string, value: string, isPromoted = true,
): Promise<string> {
  const { getDb } = await import("../db/index.js");
  const { attributes } = await import("../db/schema.js");
  void cookie; // attributes are seeded directly in tests
  const id = randomBytes(8).toString("hex");
  await getDb().db.insert(attributes).values({
    id, pageId, name, value, valuePageId: null, isPromoted, position: 0,
  });
  return id;
}

async function getPage(cookie: string, branchId: string) {
  const res = await app.inject({
    method: "GET", url: `/api/branches/${branchId}/page`, headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    id: string;
    attributes: Array<{ name: string; value: string }>;
    templates: Array<{ pageId: string; title: string; branchId: string | null; position: number }>;
    inheritedAttributes: Array<{
      name: string; value: string;
      templatePageId: string; templateTitle: string; depth: number;
    }>;
  };
}

describe("template inheritance (slice-28, brief §13.3)", () => {
  it("returns empty templates + inheritedAttributes when the page has no template relations", async () => {
    const owner = await signup("tpl-owner1@example.com");
    const spaceId = await createSpace(owner.cookie, "No Tpl Space");
    const page = await createPage(owner.cookie, spaceId, "lonely", "Lonely");
    const body = await getPage(owner.cookie, page.branchId);
    expect(body.templates).toEqual([]);
    expect(body.inheritedAttributes).toEqual([]);
  });

  it("lists the direct template in `templates` and surfaces no inherited attrs (empty template)", async () => {
    const owner = await signup("tpl-owner2@example.com");
    const spaceId = await createSpace(owner.cookie, "Empty Tpl Space");
    const page = await createPage(owner.cookie, spaceId, "p", "P");
    const tpl = await createPage(owner.cookie, spaceId, "t", "Template");
    await addRelation(owner.cookie, page.pageId, "template", tpl.pageId);
    const body = await getPage(owner.cookie, page.branchId);
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0]!.title).toBe("Template");
    expect(body.templates[0]!.pageId).toBe(tpl.pageId);
    expect(body.inheritedAttributes).toEqual([]);
  });

  it("inherits the template's attributes into inheritedAttributes with correct provenance", async () => {
    const owner = await signup("tpl-owner3@example.com");
    const spaceId = await createSpace(owner.cookie, "Inherit Space");
    const page = await createPage(owner.cookie, spaceId, "p", "P");
    const tpl = await createPage(owner.cookie, spaceId, "t", "QSO Template");
    await addRelation(owner.cookie, page.pageId, "template", tpl.pageId);
    // Seed two attributes on the template.
    await addAttribute(owner.cookie, tpl.pageId, "callsign", "W1AW", true);
    await addAttribute(owner.cookie, tpl.pageId, "band", "20m", false);

    const body = await getPage(owner.cookie, page.branchId);
    expect(body.inheritedAttributes).toHaveLength(2);
    const cs = body.inheritedAttributes.find((a) => a.name === "callsign")!;
    expect(cs.value).toBe("W1AW");
    expect(cs.templatePageId).toBe(tpl.pageId);
    expect(cs.templateTitle).toBe("QSO Template");
    expect(cs.depth).toBe(1);
  });

  it("page's own attribute overrides an inherited one with the same name (and is not in inheritedAttributes)", async () => {
    const owner = await signup("tpl-owner4@example.com");
    const spaceId = await createSpace(owner.cookie, "Override Space");
    const page = await createPage(owner.cookie, spaceId, "p", "P");
    const tpl = await createPage(owner.cookie, spaceId, "t", "T");
    await addRelation(owner.cookie, page.pageId, "template", tpl.pageId);
    await addAttribute(owner.cookie, tpl.pageId, "callsign", "TEMPLATE-VALUE", true);
    await addAttribute(owner.cookie, page.pageId, "callsign", "OWN-VALUE", true);

    const body = await getPage(owner.cookie, page.branchId);
    // inheritedAttributes should NOT contain callsign (it's on the page's own attrs).
    const inheritedCs = body.inheritedAttributes.find((a) => a.name === "callsign");
    expect(inheritedCs).toBeUndefined();
    const ownCs = body.attributes.find((a) => a.name === "callsign")!;
    expect(ownCs.value).toBe("OWN-VALUE");
  });

  it("resolves a 2-level template chain (A uses T1, T1 uses T2) — depth + provenance correct", async () => {
    const owner = await signup("tpl-owner5@example.com");
    const spaceId = await createSpace(owner.cookie, "Chain Space");
    const page = await createPage(owner.cookie, spaceId, "p", "P");
    const t1 = await createPage(owner.cookie, spaceId, "t1", "T1");
    const t2 = await createPage(owner.cookie, spaceId, "t2", "T2");
    await addRelation(owner.cookie, page.pageId, "template", t1.pageId);
    await addRelation(owner.cookie, t1.pageId, "template", t2.pageId);
    await addAttribute(owner.cookie, t2.pageId, "from-t2", "v", true);

    const body = await getPage(owner.cookie, page.branchId);
    const a = body.inheritedAttributes.find((x) => x.name === "from-t2")!;
    expect(a.depth).toBe(2);
    expect(a.templatePageId).toBe(t2.pageId);
    expect(a.templateTitle).toBe("T2");
  });

  it("cycles (A → B → A) don't infinite-loop; both pages still get the first template's attributes", async () => {
    const owner = await signup("tpl-owner6@example.com");
    const spaceId = await createSpace(owner.cookie, "Cycle Space");
    const a = await createPage(owner.cookie, spaceId, "a", "A");
    const b = await createPage(owner.cookie, spaceId, "b", "B");
    await addRelation(owner.cookie, a.pageId, "template", b.pageId);
    await addRelation(owner.cookie, b.pageId, "template", a.pageId);
    await addAttribute(owner.cookie, b.pageId, "from-b", "v", true);
    await addAttribute(owner.cookie, a.pageId, "from-a", "v", true);

    // Should not throw, and A should still resolve cleanly.
    const bodyA = await getPage(owner.cookie, a.branchId);
    expect(bodyA.inheritedAttributes.find((x) => x.name === "from-b")).toBeTruthy();
    expect(bodyA.inheritedAttributes.find((x) => x.name === "from-a")).toBeUndefined();
  });

  it("drops a direct template the caller can't read (no existence leak)", async () => {
    const owner = await signup("tpl-owner7@example.com");
    const visitor = await signup("tpl-visitor7@example.com");
    const publicSpace = await createSpace(owner.cookie, "Public Tpl Space");
    const privateSpace = await createSpace(owner.cookie, "Private Tpl Space");
    const publicPage = await createPage(owner.cookie, publicSpace, "p", "PublicP");
    const privateTpl = await createPage(owner.cookie, privateSpace, "t", "PrivateTpl");

    await addRelation(owner.cookie, publicPage.pageId, "template", privateTpl.pageId);
    await addMember(owner.cookie, publicSpace, visitor.userId, "viewer");

    // visitor can read publicPage, but not privateTpl. The template ref
    // should be dropped server-side (no existence leak).
    const body = await getPage(visitor.cookie, publicPage.branchId);
    expect(body.templates).toEqual([]);
    expect(body.inheritedAttributes).toEqual([]);
  });
});