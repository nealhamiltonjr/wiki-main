import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const DB_PATH = `data/test-hooks-events-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-hooks-events-repo-${randomBytes(4).toString("hex")}`;
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

beforeEach(async () => {
  const { __resetHookRegistry } = await import("../hooks.js");
  __resetHookRegistry();
});

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  return raw?.split(";")[0] ?? "";
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

async function createSpace(cookie: string, slug: string): Promise<{ id: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/spaces",
    headers: { cookie },
    payload: { slug, name: slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function createPage(cookie: string, spaceId: string, slug: string, title: string): Promise<{ pageId: string; branchId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/spaces/${spaceId}/pages`,
    headers: { cookie },
    payload: { slug, title },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { pageId: string; branchId: string };
}

describe("hook events fire from real routes (slice-30)", () => {
  it("pageLoad fires when GET /api/branches/:branchId/page succeeds", async () => {
    const { registerHook } = await import("../hooks.js");
    const me = await signup(`hookuser-${randomBytes(3).toString("hex")}@test.invalid`);
    const space = await createSpace(me.cookie, `hookspace-${randomBytes(3).toString("hex")}`);
    const page = await createPage(me.cookie, space.id, "hook-page", "Hook Page");

    const seen: Array<{ event: string; pageId: string; branchId: string }> = [];
    registerHook("test-plugin", "pageLoad", (e) => {
      if (e.event === "pageLoad") {
        seen.push({ event: e.event, pageId: e.pageId, branchId: e.branchId });
      }
    });

    const get = await app.inject({
      method: "GET",
      url: `/api/branches/${page.branchId}/page`,
      headers: { cookie: me.cookie },
    });
    expect(get.statusCode).toBe(200);

    // dispatchHook is async; the route doesn't await it (fire-and-forget).
    // Give the microtask queue a turn to drain.
    await new Promise((r) => setTimeout(r, 25));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe("pageLoad");
    expect(seen[0]!.pageId).toBe(page.pageId);
    expect(seen[0]!.branchId).toBe(page.branchId);
  });

  it("pageSave fires when PUT /api/branches/:branchId/page/content succeeds", async () => {
    const { registerHook } = await import("../hooks.js");
    const me = await signup(`hooksave-${randomBytes(3).toString("hex")}@test.invalid`);
    const space = await createSpace(me.cookie, `hooksavespace-${randomBytes(3).toString("hex")}`);
    const page = await createPage(me.cookie, space.id, "save-page", "Save Page");

    const seen: Array<{ event: string; pageId: string; branchId: string; actorUserId: string }> = [];
    registerHook("test-plugin", "pageSave", (e) => {
      if (e.event === "pageSave") {
        seen.push({ event: e.event, pageId: e.pageId, branchId: e.branchId, actorUserId: e.actorUserId });
      }
    });

    // First, fetch the page so we know the current updatedAt.
    const before = await app.inject({
      method: "GET",
      url: `/api/branches/${page.branchId}/page`,
      headers: { cookie: me.cookie },
    });
    expect(before.statusCode).toBe(200);
    const beforeJson = before.json() as { updatedAt: string };
    await new Promise((r) => setTimeout(r, 10)); // drain the pageLoad hook we just triggered

    const save = await app.inject({
      method: "PUT",
      url: `/api/branches/${page.branchId}/page/content`,
      headers: { cookie: me.cookie },
      payload: {
        content: { type: "doc", content: [{ type: "paragraph" }] },
        title: "Save Page",
        expectedUpdatedAt: beforeJson.updatedAt,
      },
    });
    expect(save.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 25));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe("pageSave");
    expect(seen[0]!.pageId).toBe(page.pageId);
    expect(seen[0]!.branchId).toBe(page.branchId);
    expect(seen[0]!.actorUserId).toBe(me.userId);
  });

  it("attributeChange/set fires when POST /api/pages/:pageId/relations succeeds", async () => {
    const { registerHook } = await import("../hooks.js");
    const me = await signup(`hookattr-${randomBytes(3).toString("hex")}@test.invalid`);
    const space = await createSpace(me.cookie, `hookattrspace-${randomBytes(3).toString("hex")}`);
    const source = await createPage(me.cookie, space.id, "attr-src", "Source");
    const target = await createPage(me.cookie, space.id, "attr-tgt", "Target");

    const seen: Array<{ event: string; action: string; name: string; targetId: string }> = [];
    registerHook("test-plugin", "attributeChange", (e) => {
      if (e.event === "attributeChange") {
        seen.push({
          event: e.event,
          action: e.action,
          name: e.attribute.name,
          targetId: e.pageId,
        });
      }
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/pages/${source.pageId}/relations`,
      headers: { cookie: me.cookie },
      payload: { type: "depends on", toPageId: target.pageId },
    });
    expect(res.statusCode).toBe(201);

    await new Promise((r) => setTimeout(r, 25));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe("attributeChange");
    expect(seen[0]!.action).toBe("set");
    expect(seen[0]!.name).toBe("depends on");
    expect(seen[0]!.targetId).toBe(source.pageId);
  });

  it("attributeChange/delete fires when DELETE /api/pages/:pageId/relations/:attrId succeeds", async () => {
    const { registerHook } = await import("../hooks.js");
    const me = await signup(`hookdel-${randomBytes(3).toString("hex")}@test.invalid`);
    const space = await createSpace(me.cookie, `hookdelspace-${randomBytes(3).toString("hex")}`);
    const source = await createPage(me.cookie, space.id, "del-src", "Del Source");
    const target = await createPage(me.cookie, space.id, "del-tgt", "Del Target");

    const create = await app.inject({
      method: "POST",
      url: `/api/pages/${source.pageId}/relations`,
      headers: { cookie: me.cookie },
      payload: { type: "is a component of", toPageId: target.pageId },
    });
    expect(create.statusCode).toBe(201);
    const relId = (create.json() as { id: string }).id;

    const seen: Array<{ event: string; action: string; name: string; targetId: string }> = [];
    registerHook("test-plugin", "attributeChange", (e) => {
      if (e.event === "attributeChange") {
        seen.push({
          event: e.event,
          action: e.action,
          name: e.attribute.name,
          targetId: e.pageId,
        });
      }
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/pages/${source.pageId}/relations/${relId}`,
      headers: { cookie: me.cookie },
    });
    expect(del.statusCode).toBe(204);

    await new Promise((r) => setTimeout(r, 25));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe("attributeChange");
    expect(seen[0]!.action).toBe("delete");
    expect(seen[0]!.name).toBe("is a component of");
    expect(seen[0]!.targetId).toBe(source.pageId);
  });

  it("a throwing handler does NOT break the host request", async () => {
    const { registerHook } = await import("../hooks.js");
    const me = await signup(`hookthrow-${randomBytes(3).toString("hex")}@test.invalid`);
    const space = await createSpace(me.cookie, `hookthrowspace-${randomBytes(3).toString("hex")}`);
    const page = await createPage(me.cookie, space.id, "throw-page", "Throw Page");

    registerHook("bad-plugin", "pageLoad", () => {
      throw new Error("kaboom");
    });
    // Suppress the console.error from the dispatcher's error isolation.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const get = await app.inject({
      method: "GET",
      url: `/api/branches/${page.branchId}/page`,
      headers: { cookie: me.cookie },
    });
    // The user-facing request must still succeed.
    expect(get.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 25));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});