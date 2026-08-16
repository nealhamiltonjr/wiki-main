import path from "node:path";
import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pages, branches, comments, commentThreads, files, templates, tokens, spaces, auditLog, systemSettings, notifications, favorites, pinnedPages } from "../db/schema.js";
import { unindexPageForSearch } from "./search.service.js";

const FILES_ROOT = process.env.FILES_ROOT ?? "./data/files";

export async function reassignUserContent(userId: string, targetId: string): Promise<void> {
  const { db } = getDb();
  await db.update(pages).set({ ownerId: targetId }).where(eq(pages.ownerId, userId));
  await db.update(branches).set({ createdBy: targetId }).where(eq(branches.createdBy, userId));
  await db.update(commentThreads).set({ createdBy: targetId }).where(eq(commentThreads.createdBy, userId));
  await db.update(commentThreads).set({ resolvedBy: targetId }).where(eq(commentThreads.resolvedBy, userId));
  await db.update(comments).set({ userId: targetId }).where(eq(comments.userId, userId));
  await db.update(files).set({ uploadedBy: targetId }).where(eq(files.uploadedBy, userId));
  await db.update(templates).set({ createdBy: targetId }).where(eq(templates.createdBy, userId));
  await db.update(tokens).set({ createdBy: targetId }).where(eq(tokens.createdBy, userId));
  await db.update(spaces).set({ createdBy: targetId }).where(eq(spaces.createdBy, userId));
  await db.update(auditLog).set({ actorUserId: null }).where(eq(auditLog.actorUserId, userId));
  await db.update(systemSettings).set({ updatedBy: null }).where(eq(systemSettings.updatedBy, userId));
}

export async function deleteUserContent(userId: string, spacesFallbackUserId: string): Promise<void> {
  const { db, sqlite } = getDb();
  const blobPaths = sqlite.transaction(() => {
    db.update(spaces).set({ createdBy: spacesFallbackUserId }).where(eq(spaces.createdBy, userId)).run();
    db.delete(tokens).where(eq(tokens.createdBy, userId)).run();
    db.delete(templates).where(eq(templates.createdBy, userId)).run();
    const fileRows = db.select({ id: files.id, storagePath: files.storagePath }).from(files).where(eq(files.uploadedBy, userId)).all();
    db.delete(files).where(eq(files.uploadedBy, userId)).run();
    db.delete(comments).where(eq(comments.userId, userId)).run();
    db.delete(commentThreads).where(eq(commentThreads.createdBy, userId)).run();
    const branchRows = db.select({ id: branches.id, parentBranchId: branches.parentBranchId }).from(branches).where(eq(branches.createdBy, userId)).all();
    for (const b of branchRows) { db.update(branches).set({ parentBranchId: b.parentBranchId }).where(eq(branches.parentBranchId, b.id)).run(); }
    db.delete(branches).where(eq(branches.createdBy, userId)).run();
    const ownedPages = db.select({ id: pages.id }).from(pages).where(eq(pages.ownerId, userId)).all();
    db.delete(pages).where(eq(pages.ownerId, userId)).run();
    for (const p of ownedPages) unindexPageForSearch(p.id);
    db.delete(notifications).where(eq(notifications.userId, userId)).run();
    db.delete(favorites).where(eq(favorites.userId, userId)).run();
    db.delete(pinnedPages).where(eq(pinnedPages.userId, userId)).run();
    return fileRows.map((f) => f.storagePath);
  })();
  for (const rel of blobPaths) { try { await rm(path.join(FILES_ROOT, rel), { force: true }); } catch { /* */ } }
}
