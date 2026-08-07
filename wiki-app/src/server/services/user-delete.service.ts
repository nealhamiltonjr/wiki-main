import path from "node:path";
import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches, comments, commentThreads, files, templates, tokens, spaces, auditLog, systemSettings } from "../db/schema.js";
import { removePageFromIndex } from "./search.service.js";

const FILES_ROOT = process.env.FILES_ROOT ?? "./data/files";

/**
 * Safe user deletion (§ admin): every table with a NOT NULL foreign key to
 * users.id must be handled before the user row can be removed (SQLite FKs are
 * enforced - `pragma foreign_keys = ON` in db/index.ts).
 *
 * Two policies:
 * - reassignUserContent: hand all owned artifacts to another user.
 * - deleteUserContent: permanently remove the user's artifacts (spaces are
 *   shared containers, so they are kept and handed to a fallback user).
 *
 * Cascade-safe rows (user_groups, space_members, user_settings, notifications,
 * favorites, sessions) need no explicit handling - they follow the user row.
 */

/** Every owned artifact is transferred to `targetId`. */
export async function reassignUserContent(userId: string, targetId: string): Promise<void> {
  await db.update(pages).set({ ownerId: targetId }).where(eq(pages.ownerId, userId));
  await db.update(branches).set({ createdBy: targetId }).where(eq(branches.createdBy, userId));
  await db.update(commentThreads).set({ createdBy: targetId }).where(eq(commentThreads.createdBy, userId));
  await db.update(commentThreads).set({ resolvedBy: targetId }).where(eq(commentThreads.resolvedBy, userId));
  await db.update(comments).set({ userId: targetId }).where(eq(comments.userId, userId));
  await db.update(files).set({ uploadedBy: targetId }).where(eq(files.uploadedBy, userId));
  await db.update(templates).set({ createdBy: targetId }).where(eq(templates.createdBy, userId));
  await db.update(tokens).set({ createdBy: targetId }).where(eq(tokens.createdBy, userId));
  await db.update(spaces).set({ createdBy: targetId }).where(eq(spaces.createdBy, userId));
  // Nullable audit references: keep the trail, drop the pointer to the deleted user.
  await db.update(auditLog).set({ actorUserId: null }).where(eq(auditLog.actorUserId, userId));
  await db.update(systemSettings).set({ updatedBy: null }).where(eq(systemSettings.updatedBy, userId));
}

/**
 * Permanently deletes the user's content. `spacesFallbackUserId` receives any
 * spaces the user created (a space holds everyone's content and must never be
 * deleted with one member). Page rows cascade to their branches, comment
 * threads/comments, files, templates, backlinks, and attributes.
 */
export async function deleteUserContent(userId: string, spacesFallbackUserId: string): Promise<void> {
  const blobPaths = db.transaction((tx) => {
    // Spaces are shared containers - keep them, reassign creator to the fallback user.
    tx.update(spaces).set({ createdBy: spacesFallbackUserId }).where(eq(spaces.createdBy, userId)).run();

    // Share links / API tokens die with the user.
    tx.delete(tokens).where(eq(tokens.createdBy, userId)).run();

    // Templates the user made.
    tx.delete(templates).where(eq(templates.createdBy, userId)).run();

    // Files the user uploaded (blobs removed after commit, best-effort).
    const fileRows = tx.select({ id: files.id, storagePath: files.storagePath }).from(files).where(eq(files.uploadedBy, userId)).all();
    tx.delete(files).where(eq(files.uploadedBy, userId)).run();

    // Comments and threads the user authored on other people's pages.
    tx.delete(comments).where(eq(comments.userId, userId)).run();
    tx.delete(commentThreads).where(eq(commentThreads.createdBy, userId)).run();

    // Branch placements the user created. `parent_branch_id` has NO ACTION on
    // delete, so reparent any children to the removed branch's own parent
    // (null when the removed branch was a root) to keep ancestry chains intact.
    const branchRows = tx.select({ id: branches.id, parentBranchId: branches.parentBranchId }).from(branches).where(eq(branches.createdBy, userId)).all();
    for (const b of branchRows) {
      tx.update(branches).set({ parentBranchId: b.parentBranchId }).where(eq(branches.parentBranchId, b.id)).run();
    }
    tx.delete(branches).where(eq(branches.createdBy, userId)).run();

    // Pages the user owns.
    const ownedPages = tx.select({ id: pages.id }).from(pages).where(eq(pages.ownerId, userId)).all();
    tx.delete(pages).where(eq(pages.ownerId, userId)).run();
    for (const p of ownedPages) removePageFromIndex(p.id);

    return fileRows.map((f) => f.storagePath);
  });

  // Best-effort blob cleanup - a missing file must never fail the deletion.
  for (const rel of blobPaths) {
    try {
      await rm(path.join(FILES_ROOT, rel), { force: true });
    } catch {
      // ignore
    }
  }
}
