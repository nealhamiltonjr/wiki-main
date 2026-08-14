import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-lens-attr-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-lens-attr-repo-${randomBytes(4).toString("hex")}`;
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
  return { cookie: extractCookie(res.headers["set-cookie"]), userId: (res.json() as { user: { id: string } }).user.id };
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

/** Seed an attribute directly. `isPromoted` defaults to true because
 *  the table/board views only show promoted attrs. */
async function seedAttr(
  pageId: string,
  name: string,
  value: string,
  isPromoted = true,
): Promise<void> {
  const { getDb } = await import("../db/index.js");
  const { attributes } = await import("../db/schema.js");
  await getDb().db.insert(attributes).values({
    id: randomBytes(8).toString("hex"),
    pageId, name, value, valuePageId: null, isPromoted, position: 0,
  });
}

async function addRelation(
  cookie: string, fromPageId: string, type: string, toPageId: string,
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/pages/${fromPageId}/relations`,
    headers: { cookie },
    payload: { type, toPageId, position: 0 },
  });
  expect(res.statusCode).toBe(201);
}

async function createLens(
  cookie: string,
  criteria: Record<string, unknown>,
  name = "Test Lens",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/lenses",
    headers: { cookie },
    payload: { name, criteria, visibility: "private" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

interface EnrichedHit {
  pageId: string;
  title: string;
  promotedAttributes: Array<{
    name: string;
    value: string;
    own: boolean;
    fromTitle?: string;
  }>;
}

async function runLens(
  cookie: string, lensId: string, includeAttributes: boolean,
): Promise<EnrichedHit[]> {
  const url = `/api/lenses/${lensId}/results${includeAttributes ? "?include=attributes" : ""}`;
  const res = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { hits: EnrichedHit[] }).hits;
}

describe("lens attribute enrichment (slice-29, brief §13.4)", () => {
  it("returns no `promotedAttributes` field on the default list endpoint", async () => {
    const owner = await signup("la-owner1@example.com");
    const spaceId = await createSpace(owner.cookie, "LA Space 1");
    const page = await createPage(owner.cookie, spaceId, "p", "P");
    await seedAttr(page.pageId, "callsign", "W1AW");
    const lensId = await createLens(owner.cookie, { tags: [] });
    const res = await app.inject({
      method: "GET",
      url: `/api/lenses/${lensId}/results`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const hits = (res.json() as { hits: Array<Record<string, unknown>> }).hits;
    for (const h of hits) expect(h.promotedAttributes).toBeUndefined();
  });

  it("includes own promoted attributes when ?include=attributes", async () => {
    const owner = await signup("la-owner2@example.com");
    const spaceId = await createSpace(owner.cookie, "LA Space 2");
    const a = await createPage(owner.cookie, spaceId, "a", "Alpha");
    const b = await createPage(owner.cookie, spaceId, "b", "Beta");
    await seedAttr(a.pageId, "callsign", "W1AW");
    await seedAttr(a.pageId, "band", "20m");
    await seedAttr(b.pageId, "callsign", "K2ABC");

    const lensId = await createLens(owner.cookie, { tags: [] });
    const hits = await runLens(owner.cookie, lensId, true);

    // Find Alpha (title sort: Alpha first)
    const alpha = hits.find((h) => h.title === "Alpha")!;
    expect(alpha).toBeTruthy();
    expect(alpha.promotedAttributes.map((a) => a.name)).toEqual(["band", "callsign"]);
    const cs = alpha.promotedAttributes.find((a) => a.name === "callsign")!;
    expect(cs.value).toBe("W1AW");
    expect(cs.own).toBe(true);
    expect(cs.fromTitle).toBeUndefined();
  });

  it("filters out non-promoted attributes", async () => {
    const owner = await signup("la-owner3@example.com");
    const spaceId = await createSpace(owner.cookie, "LA Space 3");
    const page = await createPage(owner.cookie, spaceId, "p", "P");
    await seedAttr(page.pageId, "callsign", "W1AW", true);
    await seedAttr(page.pageId, "internal-note", "do not display", false);

    const lensId = await createLens(owner.cookie, { tags: [] });
    const hits = await runLens(owner.cookie, lensId, true);
    const names = hits[0]!.promotedAttributes.map((a) => a.name);
    expect(names).toContain("callsign");
    expect(names).not.toContain("internal-note");
  });

  it("inherits promoted attributes from a template via §13.3", async () => {
    const owner = await signup("la-owner4@example.com");
    const spaceId = await createSpace(owner.cookie, "LA Space 4");
    const tpl = await createPage(owner.cookie, spaceId, "t", "QSO Template");
    await seedAttr(tpl.pageId, "callsign", "TEMPLATE");
    await seedAttr(tpl.pageId, "band", "DEFAULT-BAND");

    const page = await createPage(owner.cookie, spaceId, "p", "First QSO");
    await addRelation(owner.cookie, page.pageId, "template", tpl.pageId);
    // Own promoted attribute with the same name → should override.
    await seedAttr(page.pageId, "callsign", "OWN-CALL");

    const lensId = await createLens(owner.cookie, { tags: [] });
    const hits = await runLens(owner.cookie, lensId, true);
    const hit = hits.find((h) => h.pageId === page.pageId)!;

    const cs = hit.promotedAttributes.find((a) => a.name === "callsign")!;
    expect(cs.value).toBe("OWN-CALL");
    expect(cs.own).toBe(true);

    const band = hit.promotedAttributes.find((a) => a.name === "band")!;
    expect(band.value).toBe("DEFAULT-BAND");
    expect(band.own).toBe(false);
    expect(band.fromTitle).toBe("QSO Template");
  });

  it("drops inherited promoted attributes whose template is unreadable", async () => {
    const owner = await signup("la-owner5@example.com");
    const visitor = await signup("la-visitor5@example.com");
    const publicSpace = await createSpace(owner.cookie, "LA Pub");
    const privateSpace = await createSpace(owner.cookie, "LA Priv");
    const publicPage = await createPage(owner.cookie, publicSpace, "p", "Pub");
    const privateTpl = await createPage(owner.cookie, privateSpace, "t", "Priv Tpl");
    await seedAttr(publicPage.pageId, "callsign", "OWN");
    await seedAttr(privateTpl.pageId, "callsign", "TPL");
    await addRelation(owner.cookie, publicPage.pageId, "template", privateTpl.pageId);
    await addMember(owner.cookie, publicSpace, visitor.userId, "viewer");

    // Visitor can read publicPage but not privateTpl; the inherited attr
    // should not surface (and the visitor should still see the own one).
    const lensId = await createLens(visitor.cookie, { tags: [] });
    const hits = await runLens(visitor.cookie, lensId, true);
    const hit = hits.find((h) => h.pageId === publicPage.pageId)!;
    const cs = hit.promotedAttributes.find((a) => a.name === "callsign");
    expect(cs?.value).toBe("OWN");
    expect(cs?.own).toBe(true);
  });

  it("works via the share-token endpoint", async () => {
    const owner = await signup("la-owner6@example.com");
    const spaceId = await createSpace(owner.cookie, "LA Token");
    const page = await createPage(owner.cookie, spaceId, "p", "P");
    await seedAttr(page.pageId, "callsign", "W1AW");

    // Create an unlisted lens with a share token.
    const createRes = await app.inject({
      method: "POST",
      url: "/api/lenses",
      headers: { cookie: owner.cookie },
      payload: {
        name: "Token Lens",
        criteria: { tags: [] },
        visibility: "unlisted",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const lens = createRes.json() as { id: string; shareToken: string };
    expect(lens.shareToken).toBeTruthy();

    const res = await app.inject({
      method: "GET",
      url: `/api/lenses/by-token/${lens.shareToken}/results?include=attributes`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const hits = (res.json() as { hits: EnrichedHit[] }).hits;
    const hit = hits.find((h) => h.pageId === page.pageId)!;
    expect(hit.promotedAttributes.find((a) => a.name === "callsign")?.value).toBe("W1AW");
  });
});