import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-graph-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-graph-repo-${randomBytes(4).toString("hex")}`;
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
    method: "POST",
    url: "/api/spaces",
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createPage(
  cookie: string,
  spaceId: string,
  slug: string,
  title: string,
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

async function getUpdatedAt(cookie: string, branchId: string): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: `/api/branches/${branchId}/page`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { updatedAt: string }).updatedAt;
}

async function savePageContent(
  cookie: string,
  branchId: string,
  content: unknown,
  expectedUpdatedAt: string,
): Promise<void> {
  const res = await app.inject({
    method: "PUT",
    url: `/api/branches/${branchId}/page/content`,
    headers: { cookie },
    payload: { content, expectedUpdatedAt },
  });
  expect(res.statusCode).toBe(200);
}

async function addMember(
  cookie: string,
  spaceId: string,
  userId: string,
  role: "viewer" | "editor",
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/members`,
    headers: { cookie },
    payload: { userId, role },
  });
  expect(res.statusCode).toBe(201);
}

/** Build a ProseMirror doc containing a single link mark pointing at
 *  `targetBranchId`. Mirrors the on-disk content shape so refreshBacklinks
 *  picks it up on save. */
function docWithInternalLink(text: string, targetBranchId: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text,
            marks: [
              {
                type: "link",
                attrs: { href: `/api/branches/${targetBranchId}/page` },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function addRelation(
  cookie: string,
  fromPageId: string,
  type: string,
  toPageId: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/pages/${fromPageId}/relations`,
    headers: { cookie },
    payload: { type, toPageId, position: 0 },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "backlink" | "relation";
  label: string | null;
  direction: "out" | "in";
}
interface GraphNode {
  id: string;
  title: string;
  branchId: string | null;
  isCenter: boolean;
}
interface GraphResponse {
  center: string;
  hops: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

describe("graph endpoint (slice-27 §13.2)", () => {
  it("returns the center node alone when the page has no connections", async () => {
    const owner = await signup("owner-alone@example.com");
    const spaceId = await createSpace(owner.cookie, "Solo Space");
    const page = await createPage(owner.cookie, spaceId, "lonely", "Lonely Page");

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${page.pageId}/graph`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as GraphResponse;
    expect(body.center).toBe(page.pageId);
    expect(body.hops).toBe(1);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]!.isCenter).toBe(true);
    expect(body.nodes[0]!.id).toBe(page.pageId);
    expect(body.edges).toEqual([]);
  });

  it("returns outgoing backlinks as 'out' edges (A links → B)", async () => {
    const owner = await signup("owner-link@example.com");
    const spaceId = await createSpace(owner.cookie, "Linked Space");
    const a = await createPage(owner.cookie, spaceId, "a", "A");
    const b = await createPage(owner.cookie, spaceId, "b", "B");

    // Save A's content so it has an internal link to B. This triggers
    // refreshBacklinks, populating the backlinks table.
    const aUpdated = await getUpdatedAt(owner.cookie, a.branchId);
    await savePageContent(owner.cookie, a.branchId, docWithInternalLink("go to B", b.branchId), aUpdated);

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${a.pageId}/graph`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as GraphResponse;
    expect(body.nodes.map((n) => n.id).sort()).toEqual([a.pageId, b.pageId].sort());
    const backlinkEdge = body.edges.find((e) => e.kind === "backlink");
    expect(backlinkEdge).toBeTruthy();
    expect(backlinkEdge!.from).toBe(a.pageId);
    expect(backlinkEdge!.to).toBe(b.pageId);
    expect(backlinkEdge!.direction).toBe("out");
  });

  it("returns incoming backlinks as 'in' edges (B links → A)", async () => {
    const owner = await signup("owner-bklink@example.com");
    const spaceId = await createSpace(owner.cookie, "Backlinked Space");
    const a = await createPage(owner.cookie, spaceId, "a", "A");
    const b = await createPage(owner.cookie, spaceId, "b", "B");

    // Save B with an internal link to A.
    const bUpdated = await getUpdatedAt(owner.cookie, b.branchId);
    await savePageContent(owner.cookie, b.branchId, docWithInternalLink("see A", a.branchId), bUpdated);

    // Now request graph for A — should see B as an incoming backlink.
    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${a.pageId}/graph`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as GraphResponse;
    const backlinkEdge = body.edges.find((e) => e.kind === "backlink");
    expect(backlinkEdge).toBeTruthy();
    expect(backlinkEdge!.from).toBe(b.pageId);
    expect(backlinkEdge!.to).toBe(a.pageId);
    expect(backlinkEdge!.direction).toBe("in");
  });

  it("includes typed relations alongside backlinks with the relation type as label", async () => {
    const owner = await signup("owner-rel@example.com");
    const spaceId = await createSpace(owner.cookie, "Mixed Space");
    const a = await createPage(owner.cookie, spaceId, "a", "A");
    const b = await createPage(owner.cookie, spaceId, "b", "B");
    await addRelation(owner.cookie, a.pageId, "depends on", b.pageId);

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${a.pageId}/graph`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as GraphResponse;
    const rel = body.edges.find((e) => e.kind === "relation");
    expect(rel).toBeTruthy();
    expect(rel!.label).toBe("depends on");
    expect(rel!.from).toBe(a.pageId);
    expect(rel!.to).toBe(b.pageId);
    expect(rel!.direction).toBe("out");
  });

  it("dedupes when a page has both a backlink and a relation to the same target", async () => {
    const owner = await signup("owner-dedup@example.com");
    const spaceId = await createSpace(owner.cookie, "Dedup Space");
    const a = await createPage(owner.cookie, spaceId, "a", "A");
    const b = await createPage(owner.cookie, spaceId, "b", "B");

    const aUpdated = await getUpdatedAt(owner.cookie, a.branchId);
    await savePageContent(owner.cookie, a.branchId, docWithInternalLink("go to B", b.branchId), aUpdated);
    await addRelation(owner.cookie, a.pageId, "depends on", b.pageId);

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${a.pageId}/graph`,
      headers: { cookie: owner.cookie },
    });
    const body = res.json() as GraphResponse;
    expect(body.nodes.filter((n) => n.id === b.pageId)).toHaveLength(1);
    // Two distinct edges from A to B (different kinds/labels).
    const aToB = body.edges.filter((e) => e.from === a.pageId && e.to === b.pageId);
    expect(aToB).toHaveLength(2);
  });

  it("404s the endpoint for an unreadable center (no existence leak)", async () => {
    const owner = await signup("owner-private@example.com");
    const peeker = await signup("peeker@example.com");
    const spaceId = await createSpace(owner.cookie, "Private Space");
    const a = await createPage(owner.cookie, spaceId, "secret", "Secret");

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${a.pageId}/graph`,
      headers: { cookie: peeker.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("filters out neighbors in spaces the caller cannot read (no existence leak)", async () => {
    const owner = await signup("owner-mixed@example.com");
    const visitor = await signup("visitor@example.com");
    const publicSpace = await createSpace(owner.cookie, "Public Space");
    const privateSpace = await createSpace(owner.cookie, "Private Space");

    const publicPage = await createPage(owner.cookie, publicSpace, "pub", "Public");
    const privatePage = await createPage(owner.cookie, privateSpace, "priv", "Private");

    // Add visitor as viewer on the public space only.
    await addMember(owner.cookie, publicSpace, visitor.userId, "viewer");

    // Add a relation from publicPage to privatePage. The visitor can
    // see the public space but not the private one — the relation
    // endpoint on the server already filters target by accessibility,
    // so this add will fail with 400. We test the *backlink* path
    // instead: make publicPage link to privatePage via an internal
    // link mark, then fetch the graph as the visitor and verify the
    // private target is absent.
    const publicUpdated = await getUpdatedAt(owner.cookie, publicPage.branchId);
    await savePageContent(
      owner.cookie,
      publicPage.branchId,
      docWithInternalLink("see also private", privatePage.branchId),
      publicUpdated,
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/pages/${publicPage.pageId}/graph`,
      headers: { cookie: visitor.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as GraphResponse;
    const neighborIds = body.nodes.map((n) => n.id);
    expect(neighborIds).toContain(publicPage.pageId);
    expect(neighborIds).not.toContain(privatePage.pageId);
  });

  it("clamps hops to the allowed range", async () => {
    const owner = await signup("owner-hops@example.com");
    const spaceId = await createSpace(owner.cookie, "Hops Space");
    const a = await createPage(owner.cookie, spaceId, "a", "A");

    const tooBig = await app.inject({
      method: "GET",
      url: `/api/pages/${a.pageId}/graph?hops=99`,
      headers: { cookie: owner.cookie },
    });
    expect(tooBig.statusCode).toBe(200);
    expect((tooBig.json() as GraphResponse).hops).toBeLessThanOrEqual(3);

    const tooSmall = await app.inject({
      method: "GET",
      url: `/api/pages/${a.pageId}/graph?hops=0`,
      headers: { cookie: owner.cookie },
    });
    expect(tooSmall.statusCode).toBe(200);
    expect((tooSmall.json() as GraphResponse).hops).toBe(1);
  });
});