import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { buildApp } from "../app.js";
import { getDb, closeDb } from "../db/index.js";
import { resetAuth } from "../auth/config.js";
import {
  users,
  identities,
  spaces,
  spaceMembers,
  pages,
  branches,
  backlinks,
  pageRedirects,
} from "../db/schema.js";
import { renamePage } from "../services/page.service.js";
import { buildMaintenanceReport, deleteAlias } from "../services/maintenance.service.js";

const TEST_SECRET = "test-maintenance-0123456789abcdef0123456789abcdef";
const DB_PATH = `data/test-maintenance-${randomBytes(4).toString("hex")}.db`;
const TEST_EMAIL = `maintenance-${randomBytes(4).toString("hex")}@test.local`;
const EDITOR_EMAIL = `maintenance-editor-${randomBytes(4).toString("hex")}@test.local`;

let app: Awaited<ReturnType<typeof buildApp>>;
let adminId: string;
let editorId: string;
let spaceId: string;
let adminCookie: string;
let editorCookie: string;

async function seedUser(email: string, name: string, password: string): Promise<string> {
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

async function createPageWithBranch(
  slug: string,
  title: string,
  parentId: string | null = null,
): Promise<{ pageId: string; branchId: string }> {
  const db = getDb().db;
  const pageId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  await db.insert(pages).values({
    id: pageId,
    slug,
    title,
    ownerId: adminId,
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  await db.insert(branches).values({
    id: branchId,
    pageId,
    spaceId,
    createdBy: adminId,
    parentBranchId: parentId,
    position: 0,
  });
  return { pageId, branchId };
}

async function createBacklink(sourcePageId: string, targetBranchId: string): Promise<void> {
  const db = getDb().db;
  await db.insert(backlinks).values({
    sourcePageId,
    targetBranchId,
    targetBlockId: null,
  });
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

  adminId = await seedUser(TEST_EMAIL, "Admin", "TestPass-1234");
  editorId = await seedUser(EDITOR_EMAIL, "Editor", "TestPass-1234");

  spaceId = crypto.randomUUID();
  await db.insert(spaces).values({ id: spaceId, name: "Maintenance Space", createdBy: adminId });
  await db.insert(spaceMembers).values([
    { spaceId, userId: adminId, role: "admin" },
    { spaceId, userId: editorId, role: "editor" },
  ]);

  adminCookie = await signIn(TEST_EMAIL, "TestPass-1234");
  editorCookie = await signIn(EDITOR_EMAIL, "TestPass-1234");
});

afterAll(async () => {
  await app.close();
  closeDb();
  resetAuth();
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}
});

describe("maintenance report (brief §12.7)", () => {
  it("returns an empty report for a freshly-seeded space", async () => {
    const report = await buildMaintenanceReport(spaceId);
    expect(report.orphanedPages).toEqual([]);
    expect(report.brokenRedirects).toEqual([]);
    expect(report.generatedAt).toBeInstanceOf(Date);
  });

  it("flags a page with no incoming backlinks as orphaned", async () => {
    const { branchId } = await createPageWithBranch("orphan", "Orphan Page");
    const report = await buildMaintenanceReport(spaceId);
    expect(report.orphanedPages.map((o) => o.branchId)).toContain(branchId);
    expect(report.orphanedPages.find((o) => o.branchId === branchId)?.slug).toBe("orphan");
  });

  it("a page that is referenced by another page is NOT orphaned", async () => {
    const { pageId: hubId } = await createPageWithBranch("hub", "Hub");
    const { branchId: targetBranchId } = await createPageWithBranch("referenced", "Referenced");
    await createBacklink(hubId, targetBranchId);

    const report = await buildMaintenanceReport(spaceId);
    expect(report.orphanedPages.map((o) => o.branchId)).not.toContain(targetBranchId);
  });

  it("flags a redirect whose target page is in trash as 'deleted'", async () => {
    const { pageId } = await createPageWithBranch("to-rename-deleted", "To Rename Deleted");
    await renamePage(pageId, "renamed-deleted");
    const { db } = getDb();
    await db.update(pages).set({ deletedAt: new Date() }).where(eq(pages.id, pageId)).run();

    const report = await buildMaintenanceReport(spaceId);
    const broken = report.brokenRedirects.find((b) => b.oldSlug === "to-rename-deleted");
    expect(broken).toBeTruthy();
    expect(broken?.reason).toBe("deleted");
    expect(broken?.pageId).toBe(pageId);
  });

  it("flags a redirect whose target page was removed from this space as 'missing'", async () => {
    const { pageId, branchId } = await createPageWithBranch("moved-out", "Moved Out");
    await renamePage(pageId, "moved-out-new");

    const { db } = getDb();
    await db.delete(branches).where(eq(branches.id, branchId)).run();

    const report = await buildMaintenanceReport(spaceId);
    const broken = report.brokenRedirects.find((b) => b.oldSlug === "moved-out");
    expect(broken).toBeTruthy();
    expect(broken?.reason).toBe("missing");
    expect(broken?.pageId).toBe(pageId);
  });

  it("does not flag redirects whose target page is alive in this space", async () => {
    const { pageId } = await createPageWithBranch("healthy-redirect", "Healthy Redirect");
    await renamePage(pageId, "renamed-healthy");
    const report = await buildMaintenanceReport(spaceId);
    expect(report.brokenRedirects.find((b) => b.pageId === pageId)).toBeUndefined();
  });

  it("stale rows whose oldSlug matches the current slug are filtered out", async () => {
    const stub = await createPageWithBranch("back-forth", "Back Forth");
    await renamePage(stub.pageId, "renamed-once");
    await renamePage(stub.pageId, "back-forth");

    const report = await buildMaintenanceReport(spaceId);
    expect(
      report.brokenRedirects.find((b) => b.oldSlug === "back-forth" && b.pageId === stub.pageId),
    ).toBeUndefined();
  });

  it("DELETE /api/spaces/:spaceId/redirects/:oldSlug removes a single alias", async () => {
    const { pageId } = await createPageWithBranch("alias-deleted", "Alias Deleted");
    await renamePage(pageId, "new-slug");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/spaces/${spaceId}/redirects/alias-deleted`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);

    const { db } = getDb();
    const rows = db
      .select()
      .from(pageRedirects)
      .where(eq(pageRedirects.oldSlug, "alias-deleted"))
      .all();
    expect(rows).toHaveLength(0);
  });

  it("non-admins can't read the maintenance report", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/maintenance`,
      headers: { cookie: editorCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin GET returns the report", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/spaces/${spaceId}/maintenance`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orphanedPages).toBeInstanceOf(Array);
    expect(body.brokenRedirects).toBeInstanceOf(Array);
    expect(typeof body.generatedAt).toBe("string");
  });

  it("non-admins can't delete an alias", async () => {
    const { pageId } = await createPageWithBranch("cant-delete-alias", "Can't Delete Alias");
    await renamePage(pageId, "did-delete");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/spaces/${spaceId}/redirects/cant-delete-alias`,
      headers: { cookie: editorCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("deleteAlias service returns true for present rows, false for missing", async () => {
    const { pageId } = await createPageWithBranch("perm-deleted", "Perm Deleted");
    await renamePage(pageId, "perm-deleted-renamed");
    expect(await deleteAlias(spaceId, "perm-deleted")).toBe(true);
    expect(await deleteAlias(spaceId, "perm-deleted")).toBe(false);
  });
});
