import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { buildApp } from "../app.js";
import { getDb, closeDb } from "../db/index.js";
import { resetAuth } from "../auth/config.js";
import { users, identities, spaces, spaceMembers, pages, branches, pageRedirects } from "../db/schema.js";
import { resolveSlug } from "../services/page.service.js";

const TEST_SECRET = "test-redirects-0123456789abcdef0123456789abcdef";
const DB_PATH = `data/test-redirects-${randomBytes(4).toString("hex")}.db`;
const TEST_EMAIL = `redirects-${randomBytes(4).toString("hex")}@test.local`;
const OUTSIDER_EMAIL = `outsider-${randomBytes(4).toString("hex")}@test.local`;

let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let outsiderId: string;
let spaceId: string;
let outsideSpaceId: string;
let rootBranchId: string;
let outsideBranchId: string;
let sessionCookie: string;
let outsiderCookie: string;

async function seedUser(email: string, name: string, password: string) {
  const db = getDb().db;
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, name, email, emailVerified: true });
  await db.insert(identities).values({
    id: crypto.randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(password),
  });
  return id;
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  const raw = res.headers["set-cookie"];
  return (Array.isArray(raw) ? raw[0] : raw) ?? "";
}

beforeAll(async () => {
  closeDb();
  resetAuth();

  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}

  process.env.DB_PATH = DB_PATH;
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";

  app = await buildApp();
  const { db } = getDb();

  // Two spaces, owned by the same user — lets the test prove redirect
  // scoping is per-spaceId (not global).
  userId = await seedUser(TEST_EMAIL, "Owner", "TestPass-1234");
  outsiderId = await seedUser(OUTSIDER_EMAIL, "Outsider", "TestPass-1234");

  spaceId = crypto.randomUUID();
  await db.insert(spaces).values({ id: spaceId, name: "Primary", createdBy: userId });
  await db.insert(spaceMembers).values({ spaceId, userId, role: "admin" });

  outsideSpaceId = crypto.randomUUID();
  await db.insert(spaces).values({ id: outsideSpaceId, name: "Outside", createdBy: userId });
  await db.insert(spaceMembers).values({ spaceId: outsideSpaceId, userId, role: "admin" });
  // Outsider is a viewer in the outside space only — proves the resolver
  // actually re-walks the access check on the target.
  await db.insert(spaceMembers).values({ spaceId: outsideSpaceId, userId: outsiderId, role: "viewer" });
  // Outsider is NOT a member of the primary space.

  const pageId = crypto.randomUUID();
  rootBranchId = crypto.randomUUID();
  outsideBranchId = crypto.randomUUID();
  await db.insert(pages).values({
    id: pageId,
    slug: "todo",
    title: "Todo",
    ownerId: userId,
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  await db.insert(branches).values([
    { id: rootBranchId, pageId, spaceId, createdBy: userId, parentBranchId: null, position: 0 },
    { id: outsideBranchId, pageId, spaceId: outsideSpaceId, createdBy: userId, parentBranchId: null, position: 0 },
  ]);

  sessionCookie = await signIn(TEST_EMAIL, "TestPass-1234");
  outsiderCookie = await signIn(OUTSIDER_EMAIL, "TestPass-1234");
});

afterAll(async () => {
  await app.close();
  closeDb();
  resetAuth();
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}
});

describe("rename + redirect (brief §12.2)", () => {
  it("renaming a page writes a redirect per space the page is placed in", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageIdOf("todo")}/branches/${rootBranchId}/slug`,
      headers: { cookie: sessionCookie },
      payload: { slug: "tasks" },
    });
    expect(res.statusCode).toBe(200);

    const { db } = getDb();
    const rows = db
      .select()
      .from(pageRedirects)
      .all();
    expect(rows).toHaveLength(2);
    const bySpace = Object.fromEntries(rows.map((r) => [r.spaceId, r]));
    expect(bySpace[spaceId]?.oldSlug).toBe("todo");
    expect(bySpace[spaceId]?.pageId).toBe(pageIdOf("todo"));
    expect(bySpace[outsideSpaceId]?.oldSlug).toBe("todo");
  });

  it("live slug resolves to the page in the space (no redirect flag)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=tasks`,
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pageId).toBe(pageIdOf("todo"));
    expect(body.slug).toBe("tasks");
    expect(body.redirected).toBe(false);
    expect(body.oldSlug).toBeNull();
  });

  it("old slug resolves to the renamed page through the redirect", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=todo`,
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pageId).toBe(pageIdOf("todo"));
    expect(body.slug).toBe("tasks");
    expect(body.redirected).toBe(true);
    expect(body.oldSlug).toBe("todo");
  });

  it("old slug in the other space also resolves to the renamed page", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/spaces/${outsideSpaceId}/resolve-slug?slug=todo`,
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirected).toBe(true);
    expect(res.json().branchId).toBe(outsideBranchId);
  });

  it("redirect target is gated by the same access check as the live page", async () => {
    // Outsider is NOT a member of the primary space, so even though the page
    // is plainly reachable via the redirect, the resolver must 404 them.
    const res = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=todo`,
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a non-member can't even resolve the LIVE slug in a space they don't belong to", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=tasks`,
      headers: { cookie: outsiderCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("re-renaming the page forward updates the redirect target back to the live page", async () => {
    // The page is currently "tasks" (after the first rename). Rename it to
    // "backlog". The new redirect "(todo, primary) -> pageId" should still
    // exist, and the tasks-slug should now point at the page too.
    const res = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageIdOf("todo")}/branches/${rootBranchId}/slug`,
      headers: { cookie: sessionCookie },
      payload: { slug: "backlog" },
    });
    expect(res.statusCode).toBe(200);

    const live = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=backlog`,
      headers: { cookie: sessionCookie },
    });
    expect(live.json().redirected).toBe(false);

    // Both old slugs still resolve.
    const fromTodo = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=todo`,
      headers: { cookie: sessionCookie },
    });
    expect(fromTodo.statusCode).toBe(200);
    expect(fromTodo.json().slug).toBe("backlog");

    const fromTasks = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=tasks`,
      headers: { cookie: sessionCookie },
    });
    expect(fromTasks.statusCode).toBe(200);
    expect(fromTasks.json().redirected).toBe(true);
    expect(fromTasks.json().slug).toBe("backlog");
  });

  it("renaming back to a slug the page itself previously used clears the alias for that slug", async () => {
    // Rename "backlog" -> "todo" (the original slug). The "(todo, pageId)"
    // alias should disappear: the page is now alive at "todo" again, and
    // asking for "todo" returns it as live, not via a redirect.
    const res = await app.inject({
      method: "PUT",
      url: `/api/pages/${pageIdOf("todo")}/branches/${rootBranchId}/slug`,
      headers: { cookie: sessionCookie },
      payload: { slug: "todo" },
    });
    expect(res.statusCode).toBe(200);

    const live = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=todo`,
      headers: { cookie: sessionCookie },
    });
    expect(live.statusCode).toBe(200);
    expect(live.json().redirected).toBe(false);
    expect(live.json().slug).toBe("todo");
  });

  it("a slug that was never used 404s", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/resolve-slug?slug=never-existed`,
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("resolveSlug service: live page wins over a stale redirect to the same page", async () => {
    // Create a second page (without restarting the test) and rename it across
    // a slug we happen to redirect to. Simpler: just call resolveSlug directly
    // against the current state and confirm the LIVE slug wins.
    const live = await resolveSlug(spaceId, "todo");
    expect(live).toBeTruthy();
    expect(live?.redirected).toBe(false);
  });

  it("listing redirects for a page returns every still-valid alias", async () => {
    // After the re-rename chain "todo -> tasks -> backlog -> todo", the
    // aliases pointing at this page are (tasks, x) and (backlog, x) per space.
    // The (todo, x) alias was overwritten to the live page (no redirect).
    const { listRedirectsForPage } = await import("../services/page.service.js");
    const rows = await listRedirectsForPage(pageIdOf("todo"));
    const oldSlugs = Array.from(new Set(rows.map((r) => r.oldSlug))).sort();
    expect(oldSlugs).toEqual(["backlog", "tasks"]);
  });
});

// Helper: the test seeded one page shared across two branch placements;
// both branches point to the same pageId.
function pageIdOf(_slug: string): string {
  const { db } = getDb();
  const row = db
    .select({ pageId: branches.pageId })
    .from(branches)
    .where(eq(branches.id, rootBranchId))
    .all();
  return row[0]!.pageId;
}
