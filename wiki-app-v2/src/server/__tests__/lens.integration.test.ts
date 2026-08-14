import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-lens-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-lens-repo-${randomBytes(4).toString("hex")}`;
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

async function signupAndLogin(email: string): Promise<{ cookie: string; userId: string }> {
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

interface CreatePageResult {
  pageId: string;
  branchId: string;
}

async function createPage(
  cookie: string,
  spaceId: string,
  slug: string,
  title: string,
  ownerId?: string,
): Promise<CreatePageResult> {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug, title },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { pageId: string; branchId: string };
  if (ownerId) {
    // Stamp the owner_id directly so owner=self tests have a known shape.
    const { getDb } = await import("../db/index.js");
    const { pages } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await getDb().db.update(pages).set({ ownerId }).where(eq(pages.id, body.pageId));
  }
  return body;
}

async function setTag(
  _cookie: string,
  branchId: string,
  tag: string,
): Promise<void> {
  const { getDb } = await import("../db/index.js");
  const { attributes, branches, pages } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  const [row] = await getDb().db
    .select({ pageId: branches.pageId })
    .from(branches)
    .where(eq(branches.id, branchId));
  if (!row) throw new Error("setTag: branch not found");
  await getDb().db.insert(attributes).values({
    id: crypto.randomUUID(),
    pageId: row.pageId,
    name: "tag",
    value: tag,
    isPromoted: false,
    position: 0,
  });
  void pages;
}

async function setProp(
  _cookie: string,
  branchId: string,
  name: string,
  value: string,
): Promise<void> {
  const { getDb } = await import("../db/index.js");
  const { attributes, branches } = await import("../db/schema.js");
  const { eq } = await import("drizzle-orm");
  const [row] = await getDb().db
    .select({ pageId: branches.pageId })
    .from(branches)
    .where(eq(branches.id, branchId));
  if (!row) throw new Error("setProp: branch not found");
  await getDb().db.insert(attributes).values({
    id: crypto.randomUUID(),
    pageId: row.pageId,
    name,
    value,
    isPromoted: false,
    position: 0,
  });
}

describe("lens routes (brief §12.4)", () => {
  it("lets a user save a lens, list it, and run it", async () => {
    const { cookie } = await signupAndLogin(`lens-a-${randomBytes(4).toString("hex")}@x.com`);
    const spaceId = await createSpace(cookie, "LensSpace");

    const proxmox = await createPage(cookie, spaceId, "proxmox-101", "Proxmox 101");
    await setTag(cookie, proxmox.branchId, "proxmox");
    const ham = await createPage(cookie, spaceId, "antenna-feedline", "Antenna feedline");
    await setTag(cookie, ham.branchId, "ham-radio");
    await createPage(cookie, spaceId, "random-note", "Random Note");

    const create = await app.inject({
      method: "POST",
      url: "/api/lenses",
      headers: { cookie },
      payload: {
        name: "Proxmox pages",
        description: "All tagged proxmox",
        criteria: { tags: ["proxmox"] },
      },
    });
    expect(create.statusCode).toBe(201);
    const lens = create.json() as { id: string; name: string; visibility: string };
    expect(lens.visibility).toBe("private");

    const list = await app.inject({
      method: "GET",
      url: "/api/lenses",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const lenses = list.json() as Array<{ id: string; name: string }>;
    expect(lenses.some((l) => l.id === lens.id)).toBe(true);

    const run = await app.inject({
      method: "GET",
      url: `/api/lenses/${lens.id}/results`,
      headers: { cookie },
    });
    expect(run.statusCode).toBe(200);
    const body = run.json() as {
      hits: Array<{ pageId: string; title: string }>;
    };
    expect(body.hits.map((h) => h.title)).toEqual(["Proxmox 101"]);
  });

  it("filters by title regex", async () => {
    const { cookie } = await signupAndLogin(`lens-b-${randomBytes(4).toString("hex")}@x.com`);
    const spaceId = await createSpace(cookie, "RegexSpace");
    await createPage(cookie, spaceId, "alpha", "Alpha Protocol");
    await createPage(cookie, spaceId, "beta", "Beta Protocol");
    await createPage(cookie, spaceId, "gamma", "Gamma Ray");

    const create = await app.inject({
      method: "POST",
      url: "/api/lenses",
      headers: { cookie },
      payload: {
        name: "Protocol pages",
        criteria: { titleRegex: "Protocol$" },
      },
    });
    expect(create.statusCode).toBe(201);
    const lens = create.json() as { id: string };

    const run = await app.inject({
      method: "GET",
      url: `/api/lenses/${lens.id}/results`,
      headers: { cookie },
    });
    const body = run.json() as { hits: Array<{ title: string }> };
    expect(body.hits.map((h) => h.title).sort()).toEqual(["Alpha Protocol", "Beta Protocol"]);
  });

  it("filters by property match", async () => {
    const { cookie } = await signupAndLogin(`lens-c-${randomBytes(4).toString("hex")}@x.com`);
    const spaceId = await createSpace(cookie, "PropSpace");
    const a = await createPage(cookie, spaceId, "alpha", "Alpha");
    await setProp(cookie, a.branchId, "status", "draft");
    const b = await createPage(cookie, spaceId, "beta", "Beta");
    await setProp(cookie, b.branchId, "status", "published");
    const c = await createPage(cookie, spaceId, "gamma", "Gamma");
    await setProp(cookie, c.branchId, "status", "draft");

    const create = await app.inject({
      method: "POST",
      url: "/api/lenses",
      headers: { cookie },
      payload: {
        name: "Draft pages",
        criteria: { properties: [{ name: "status", value: "draft" }] },
      },
    });
    const lens = create.json() as { id: string };
    const run = await app.inject({
      method: "GET",
      url: `/api/lenses/${lens.id}/results`,
      headers: { cookie },
    });
    const body = run.json() as { hits: Array<{ title: string }> };
    expect(body.hits.map((h) => h.title).sort()).toEqual(["Alpha", "Gamma"]);
  });

  it("filters by owner=self", async () => {
    const me = await signupAndLogin(`lens-d-me-${randomBytes(4).toString("hex")}@x.com`);
    const other = await signupAndLogin(`lens-d-other-${randomBytes(4).toString("hex")}@x.com`);
    const spaceId = await createSpace(me.cookie, "SelfSpace");

    // Pages owned by the other user; admin moves ownership via raw update.
    const { getDb } = await import("../db/index.js");
    const { pages } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const a = await createPage(me.cookie, spaceId, "owned-by-me", "Mine");
    await getDb().db.update(pages).set({ ownerId: me.userId }).where(eq(pages.id, a.pageId));
    const b = await createPage(me.cookie, spaceId, "owned-by-other", "Theirs");
    await getDb().db.update(pages).set({ ownerId: other.userId }).where(eq(pages.id, b.pageId));

    const create = await app.inject({
      method: "POST",
      url: "/api/lenses",
      headers: { cookie: me.cookie },
      payload: { name: "Mine only", criteria: { ownerScope: "self" } },
    });
    const lens = create.json() as { id: string };
    const run = await app.inject({
      method: "GET",
      url: `/api/lenses/${lens.id}/results`,
      headers: { cookie: me.cookie },
    });
    const body = run.json() as { hits: Array<{ title: string }> };
    expect(body.hits.map((h) => h.title)).toEqual(["Mine"]);
  });

  it("enforces visibility: outsider cannot read a private lens", async () => {
    const owner = await signupAndLogin(`lens-e-owner-${randomBytes(4).toString("hex")}@x.com`);
    const outsider = await signupAndLogin(`lens-e-out-${randomBytes(4).toString("hex")}@x.com`);

    const create = await app.inject({
      method: "POST",
      url: "/api/lenses",
      headers: { cookie: owner.cookie },
      payload: { name: "Secret", criteria: {} },
    });
    const lens = create.json() as { id: string };

    const read = await app.inject({
      method: "GET",
      url: `/api/lenses/${lens.id}`,
      headers: { cookie: outsider.cookie },
    });
    expect(read.statusCode).toBe(403);

    const run = await app.inject({
      method: "GET",
      url: `/api/lenses/${lens.id}/results`,
      headers: { cookie: outsider.cookie },
    });
    expect(run.statusCode).toBe(403);
  });

  it("supports unlisted share-token URLs", async () => {
    const owner = await signupAndLogin(`lens-f-${randomBytes(4).toString("hex")}@x.com`);
    const spaceId = await createSpace(owner.cookie, "ShareSpace");
    const a = await createPage(owner.cookie, spaceId, "shared-1", "Shared 1");
    await setTag(owner.cookie, a.branchId, "shared");

    const create = await app.inject({
      method: "POST",
      url: "/api/lenses",
      headers: { cookie: owner.cookie },
      payload: {
        name: "Shared",
        criteria: { tags: ["shared"] },
        visibility: "unlisted",
      },
    });
    expect(create.statusCode).toBe(201);
    const lens = create.json() as { id: string; shareToken: string | null };
    expect(lens.shareToken).toBeTruthy();

    const tokenRead = await app.inject({
      method: "GET",
      url: `/api/lenses/by-token/${lens.shareToken}`,
    });
    expect(tokenRead.statusCode).toBe(200);
    const fetched = tokenRead.json() as { id: string };
    expect(fetched.id).toBe(lens.id);

    const run = await app.inject({
      method: "GET",
      url: `/api/lenses/by-token/${lens.shareToken}/results`,
      headers: { cookie: owner.cookie },
    });
    expect(run.statusCode).toBe(200);
    const body = run.json() as { hits: Array<{ title: string }> };
    expect(body.hits.map((h) => h.title)).toEqual(["Shared 1"]);
  });

  it("admin can patch/delete any lens; non-owner cannot", async () => {
    const owner = await signupAndLogin(`lens-g-own-${randomBytes(4).toString("hex")}@x.com`);
    const other = await signupAndLogin(`lens-g-out-${randomBytes(4).toString("hex")}@x.com`);
    const admin = await signupAndLogin(`lens-g-adm-${randomBytes(4).toString("hex")}@x.com`);
    const { getDb } = await import("../db/index.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await getDb().db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.userId));

    const create = await app.inject({
      method: "POST",
      url: "/api/lenses",
      headers: { cookie: owner.cookie },
      payload: { name: "Editable", criteria: {} },
    });
    const lens = create.json() as { id: string };

    const forbid = await app.inject({
      method: "PATCH",
      url: `/api/lenses/${lens.id}`,
      headers: { cookie: other.cookie },
      payload: { name: "Hacked" },
    });
    expect(forbid.statusCode).toBe(403);

    const adminPatch = await app.inject({
      method: "PATCH",
      url: `/api/lenses/${lens.id}`,
      headers: { cookie: admin.cookie },
      payload: { name: "Admin renamed" },
    });
    expect(adminPatch.statusCode).toBe(200);
    const renamed = adminPatch.json() as { name: string };
    expect(renamed.name).toBe("Admin renamed");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/lenses/${lens.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(del.statusCode).toBe(204);

    const missing = await app.inject({
      method: "GET",
      url: `/api/lenses/${lens.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  // Slice-42: ReDoS defense for lens titleRegex. A malicious lens owner
  // (or anyone with a share token for an unlisted lens) could otherwise
  // create a lens with a catastrophic-backtracking pattern and freeze
  // the server on every results call.
  describe("slice-42: titleRegex ReDoS gate", () => {
    const hostilePatterns = [
      "^(a+)+$",
      "(a+)+X",
      "(a+)+\\1",
      "(a*)*$",
      "(a+|b)+",
      "a++",
      "a+b+c+d+e+f+",
      "\\1",
    ];

    it.each(hostilePatterns)(
      "rejects the hostile regex %j at create time",
      async (pattern) => {
        const owner = await signupAndLogin(`redos-create-${randomBytes(3).toString("hex")}@test.local`);
        const create = await app.inject({
          method: "POST",
          url: "/api/lenses",
          headers: { cookie: owner.cookie },
          payload: { name: "evil", criteria: { titleRegex: pattern } },
        });
        expect(create.statusCode).toBe(400);
        const body = create.json() as { error: unknown };
        // zod flatten().error → either { formErrors, fieldErrors } shape,
        // or for a top-level refine issue the raw issue list. Either way
        // the message must mention "unsafe regex".
        expect(JSON.stringify(body.error)).toMatch(/unsafe regex/);
      },
    );

    it("rejects the same hostile regex at patch time", async () => {
      const owner = await signupAndLogin(`redos-patch-${randomBytes(3).toString("hex")}@test.local`);
      const create = await app.inject({
        method: "POST",
        url: "/api/lenses",
        headers: { cookie: owner.cookie },
        payload: { name: "innocent", criteria: { titleRegex: "^Meeting$" } },
      });
      expect(create.statusCode).toBe(201);
      const lens = create.json() as { id: string };
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/lenses/${lens.id}`,
        headers: { cookie: owner.cookie },
        payload: { criteria: { titleRegex: "^(a+)+$" } },
      });
      expect(patch.statusCode).toBe(400);
    });

    it("defense-in-depth: a legacy row with an unsafe regex still 400s when run", async () => {
      // Simulate a row that bypassed the route gate (legacy import, raw DB
      // write, or a future regression in the zod schema) by inserting the
      // malicious regex directly via the service layer. We use a real
      // signed-up user as the owner so the FK constraint is satisfied —
      // the point of the test is that the regex safety check fires
      // *before* any per-user access logic runs.
      const { createLens, runLens, UnsafeLensRegexError } = await import(
        "../services/lens.service.js"
      );
      const owner = await signupAndLogin(`redos-run-${randomBytes(3).toString("hex")}@test.local`);
      const lens = await createLens({
        ownerId: owner.userId,
        name: "legacy",
        criteria: { titleRegex: "^(a+)+$" },
      });
      await expect(
        runLens(lens, { id: owner.userId, isAdmin: true } as never),
      ).rejects.toBeInstanceOf(UnsafeLensRegexError);
    });

    it("the SQL REGEXP function refuses to execute an unsafe pattern", async () => {
      // Even if every other gate is bypassed, the db-level function is the
      // last line of defense: it throws before calling RegExp.test().
      const { getDb } = await import("../db/index.js");
      const { sqlite } = getDb();
      expect(() =>
        sqlite.prepare("SELECT regexp(?, 'value') AS m").get("^(a+)+$"),
      ).toThrow(/unsafe regex pattern/);
    });

    it("the SQL REGEXP function still works for safe patterns", async () => {
      const { getDb } = await import("../db/index.js");
      const { sqlite } = getDb();
      const row = sqlite.prepare("SELECT regexp('^hello', 'hello world') AS m").get() as
        | { m: number }
        | undefined;
      expect(row?.m).toBe(1);
    });
  });
});
