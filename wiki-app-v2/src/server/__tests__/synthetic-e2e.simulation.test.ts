import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";

/**
 * Synthetic end-to-end simulation — one in-process app, exercised over real
 * HTTP via Fastify `.inject()`, covering the full product surface the
 * redesign brief demands: admin/user management, settings, spaces, page
 * creation/writes/deletes, formatting round-trip, inline comments, templates,
 * share links, page properties, and the admin observability endpoints.
 *
 * This is deliberately NOT a UI test (that lives under e2e/*.spec.ts). It is
 * the "simulated real-usage pass" at the HTTP contract level: every call goes
 * through the same auth middleware, permission algorithm, zod validation, and
 * services a real browser would hit.
 */

const SUFFIX = randomBytes(4).toString("hex");
const DB_PATH = `data/sim-e2e-${SUFFIX}.db`;
const REPO_PATH = `data/sim-e2e-repo-${SUFFIX}`;
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

function cookieOf(res: { headers: { "set-cookie"?: string | string[] } }): string {
  const raw = Array.isArray(res.headers["set-cookie"])
    ? res.headers["set-cookie"][0]
    : res.headers["set-cookie"];
  const cookie = raw?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^better-auth.session_token=/);
  return cookie;
}

async function signup(email: string, name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "test-password-1234", name },
  });
  expect(res.statusCode).toBe(200);
  const user = (res.json() as { user: { id: string; email: string } }).user;
  return { cookie: cookieOf(res), userId: user.id, email: user.email };
}

const doc = (parts: unknown[]) => ({ type: "doc", content: parts });
const h = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
const p = (...children: unknown[]) => ({ type: "paragraph", content: children });
const t = (text: string) => ({ type: "text", text });

describe("synthetic end-to-end simulation", () => {
  it("runs the complete product lifecycle over HTTP", async () => {
    // ---- 1. Identity: first sign-up becomes admin; second is a regular user.
    const admin = await signup(`admin-${SUFFIX}@example.com`, "Admin");
    const editor = await signup(`editor-${SUFFIX}@example.com`, "Editor");
    const viewer = await signup(`viewer-${SUFFIX}@example.com`, "Viewer");

    const usersRes = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: admin.cookie } });
    expect(usersRes.statusCode).toBe(200);
    const users = usersRes.json() as Array<{ id: string; isAdmin: boolean }>;
    expect(users.find((u) => u.id === admin.userId)?.isAdmin).toBe(true);
    expect(users.find((u) => u.id === editor.userId)?.isAdmin).toBe(false);

    // ---- 2. Spaces + membership.
    const spaceRes = await app.inject({
      method: "POST", url: "/api/spaces", headers: { cookie: admin.cookie }, payload: { name: "Simulation Space" },
    });
    expect(spaceRes.statusCode).toBe(201);
    const spaceId = (spaceRes.json() as { id: string }).id;

    const addEditor = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/members`, headers: { cookie: admin.cookie },
      payload: { userId: editor.userId, role: "editor" },
    });
    expect(addEditor.statusCode).toBe(201);
    const addViewer = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/members`, headers: { cookie: admin.cookie },
      payload: { userId: viewer.userId, role: "viewer" },
    });
    expect(addViewer.statusCode).toBe(201);

    // ---- 3. Template lifecycle: blueprint page -> global template.
    const blueprintRes = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/pages`, headers: { cookie: admin.cookie },
      payload: { slug: "blueprint", title: "Blueprint" },
    });
    expect(blueprintRes.statusCode).toBe(201);
    const blueprint = blueprintRes.json() as { pageId: string; branchId: string };

    const templateRes = await app.inject({
      method: "POST", url: "/api/templates", headers: { cookie: admin.cookie },
      payload: { pageId: blueprint.pageId, name: "Meeting Notes", scope: "global" },
    });
    expect(templateRes.statusCode).toBe(201);
    const templateId = (templateRes.json() as { id: string }).id;

    const deniedTemplate = await app.inject({
      method: "POST", url: "/api/templates", headers: { cookie: editor.cookie },
      payload: { pageId: blueprint.pageId, name: "Forbidden", scope: "global" },
    });
    expect(deniedTemplate.statusCode).toBe(403);

    // ---- 4. Page creation from a template.
    const pageRes = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/pages`, headers: { cookie: editor.cookie },
      payload: { slug: "from-template", title: "From Template", templateId },
    });
    expect(pageRes.statusCode).toBe(201);
    const page = pageRes.json() as { pageId: string; branchId: string };

    // ---- 5. Formatting round-trip through the OCC save path.
    const initial = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/page`, headers: { cookie: editor.cookie } });
    expect(initial.statusCode).toBe(200);
    const initialPage = initial.json() as { id: string; updatedAt: string; content: unknown; title: string };

    const formatted = doc([
      h("Quarterly Review"),
      p(
        t("This is "),
        { type: "text", marks: [{ type: "bold" }], text: "bold" },
        t(" and "),
        { type: "text", marks: [{ type: "code" }], text: "inline code" },
      ),
    ]);
    const save = await app.inject({
      method: "PUT", url: `/api/branches/${page.branchId}/page/content`, headers: { cookie: editor.cookie },
      payload: { content: formatted, title: "From Template", titleProvided: true, expectedUpdatedAt: initialPage.updatedAt },
    });
    expect(save.statusCode).toBe(200);
    const saveBody = save.json() as { ok: boolean; updatedAt: string };
    expect(saveBody.ok).toBe(true);

    const reload = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/page`, headers: { cookie: editor.cookie } });
    expect(reload.statusCode).toBe(200);
    const reloaded = (reload.json() as { content: { type: string; content: any[] } }).content;
    // savePageOCC auto-assigns block ids, so compare structure rather than the
    // exact input object (ids are added on the first save, as designed).
    expect(reloaded.type).toBe("doc");
    expect(reloaded.content[0].type).toBe("heading");
    expect(reloaded.content[0].content[0].text).toBe("Quarterly Review");
    const paragraph = reloaded.content[1];
    expect(paragraph.type).toBe("paragraph");
    const marks = paragraph.content.flatMap((n: any) => n.marks ?? []);
    expect(marks.map((m: any) => m.type)).toEqual(expect.arrayContaining(["bold", "code"]));

    // ---- 6. Page properties (attributes).
    const attrRes = await app.inject({
      method: "POST", url: `/api/pages/${page.pageId}/attributes`, headers: { cookie: editor.cookie },
      payload: { name: "status", value: "draft", isPromoted: true },
    });
    expect(attrRes.statusCode).toBe(201);
    const attrList = await app.inject({ method: "GET", url: `/api/pages/${page.pageId}/attributes`, headers: { cookie: editor.cookie } });
    expect(attrList.statusCode).toBe(200);
    expect(
      (attrList.json() as Array<{ name: string; value: string; isPromoted: boolean }>).some(
        (a) => a.name === "status" && a.value === "draft" && a.isPromoted,
      ),
    ).toBe(true);

    // ---- 7. Nested page creation under a parent branch.
    const childRes = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/pages`, headers: { cookie: editor.cookie },
      payload: { slug: "child-page", title: "Child Page", parentBranchId: page.branchId },
    });
    expect(childRes.statusCode).toBe(201);
    const child = childRes.json() as { pageId: string; branchId: string };

    // ---- 8. Inline comment thread + reply.
    const commentRes = await app.inject({
      method: "POST", url: `/api/branches/${page.branchId}/comments`, headers: { cookie: editor.cookie },
      payload: { rangeFrom: 0, rangeTo: 5, blockId: "block-1", body: "This paragraph needs more detail", selection: "Quart" },
    });
    expect(commentRes.statusCode).toBe(201);
    const threadId = (commentRes.json() as { threadId: string }).threadId;

    const replyRes = await app.inject({
      method: "POST", url: `/api/branches/${page.branchId}/comments/${threadId}`, headers: { cookie: editor.cookie },
      payload: { body: "On it." },
    });
    expect(replyRes.statusCode).toBe(201);

    const commentsList = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/comments`, headers: { cookie: viewer.cookie } });
    expect(commentsList.statusCode).toBe(200);
    const threads = commentsList.json() as Array<{ id: string; comments: Array<{ body: string }> }>;
    const created = threads.find((th) => th.id === threadId);
    expect(created).toBeTruthy();
    expect(created!.comments.map((c) => c.body)).toEqual(["This paragraph needs more detail", "On it."]);

    // ---- 9. Share links: create, list, revoke.
    const shareRes = await app.inject({
      method: "POST", url: `/api/branches/${page.branchId}/shares`, headers: { cookie: editor.cookie },
      payload: { permission: "view", name: "Public read", password: "hunter2", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    expect(shareRes.statusCode).toBe(201);
    const share = shareRes.json() as { id: string; token: string; shareUrl: string };
    expect(share.shareUrl).toContain(share.token);

    const sharesList = await app.inject({ method: "GET", url: `/api/branches/${page.branchId}/shares`, headers: { cookie: editor.cookie } });
    expect(sharesList.statusCode).toBe(200);
    expect(
      (sharesList.json() as Array<{ id: string; passwordProtected: boolean }>).some(
        (s) => s.id === share.id && s.passwordProtected,
      ),
    ).toBe(true);

    const revoke = await app.inject({ method: "DELETE", url: `/api/shares/${share.id}`, headers: { cookie: editor.cookie } });
    expect(revoke.statusCode).toBe(200);

    // ---- 10. Per-user settings round-trip.
    const putSetting = await app.inject({
      method: "PUT", url: "/api/user-settings/editorWidth", headers: { cookie: editor.cookie }, payload: { value: 960 },
    });
    expect(putSetting.statusCode).toBe(200);
    const getSettings = await app.inject({ method: "GET", url: "/api/user-settings", headers: { cookie: editor.cookie } });
    expect(getSettings.statusCode).toBe(200);
    expect(
      (getSettings.json() as Array<{ key: string; value: number }>).find((s) => s.key === "editorWidth")?.value,
    ).toBe(960);

    // ---- 11. Soft-delete + trash restore.
    const del = await app.inject({ method: "DELETE", url: `/api/branches/${child.branchId}/page`, headers: { cookie: editor.cookie } });
    expect(del.statusCode).toBe(200);
    const trash = await app.inject({ method: "GET", url: `/api/spaces/${spaceId}/trash`, headers: { cookie: editor.cookie } });
    expect(trash.statusCode).toBe(200);
    expect((trash.json() as Array<{ pageId: string }>).some((t) => t.pageId === child.pageId)).toBe(true);

    const restore = await app.inject({
      method: "POST", url: `/api/spaces/${spaceId}/trash/restore`, headers: { cookie: editor.cookie }, payload: { pageId: child.pageId },
    });
    expect(restore.statusCode).toBe(200);

    // ---- 12. Permission boundary: viewer cannot write.
    const viewerWrite = await app.inject({
      method: "PUT", url: `/api/branches/${page.branchId}/page/content`, headers: { cookie: viewer.cookie },
      payload: { content: doc([p(t("hijack"))]), expectedUpdatedAt: saveBody.updatedAt },
    });
    expect(viewerWrite.statusCode).toBe(403);

    // ---- 13. Admin observability: system info, health, and logs.
    const info = await app.inject({ method: "GET", url: "/api/settings/system-info", headers: { cookie: admin.cookie } });
    expect(info.statusCode).toBe(200);
    const health = await app.inject({ method: "GET", url: "/api/settings/system-health", headers: { cookie: admin.cookie } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toHaveProperty("generatedAt");
    const logs = await app.inject({ method: "GET", url: "/api/settings/system-logs?limit=20", headers: { cookie: admin.cookie } });
    expect(logs.statusCode).toBe(200);
    expect(Array.isArray(logs.json())).toBe(true);

    const forbiddenHealth = await app.inject({ method: "GET", url: "/api/settings/system-health", headers: { cookie: editor.cookie } });
    expect(forbiddenHealth.statusCode).toBe(403);
  });
});
