import { eq, and, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db } from "../db/index.js";
import { pages, branches } from "../db/schema.js";
import { enqueueJob } from "../queue/index.js";
import { ensureBlockIds, type JSONBlock } from "../../shared/blockIds.js";

/** Fresh page content with every block id'd (Phase 1 backfill, §7.12d-1). */
export function newPageContent(initial?: unknown): JSONBlock {
  const base = (initial as JSONBlock | undefined) ?? { type: "doc", content: [{ type: "paragraph" }] };
  return ensureBlockIds(base);
}

export async function createPage(opts: {
  slug: string;
  title?: string;
  ownerId: string;
  spaceId: string;
  parentBranchId: string | null;
  initialContent?: unknown; // from a template, if any (template.service.ts)
}) {
  const pageId = crypto.randomUUID();
  const branchId = crypto.randomUUID();

  db.transaction((tx) => {
    tx.insert(pages).values({
      id: pageId,
      slug: opts.slug,
      title: opts.title?.trim() || opts.slug,
      ownerId: opts.ownerId,
      content: newPageContent(opts.initialContent),
    }).run();
    tx.insert(branches).values({
      id: branchId,
      pageId,
      parentBranchId: opts.parentBranchId,
      spaceId: opts.spaceId,
      visibility: "inherit",
      isSystem: false,
      createdBy: opts.ownerId,
    }).run();
  });

  return { pageId, branchId };
}

/**
 * OCC-protected save (brief §3.11) - the fallback path for any page with more
 * than one branch (cloned), and the ONLY save path until Phase 7 wires up
 * real-time collaboration for single-branch pages.
 *
 * Returns { ok: true } on success, or { ok: false, conflict: true } if someone
 * else saved first - the caller must reload rather than retry blindly.
 */
export async function savePageOCC(opts: {
  pageId: string;
  branchId: string; // which placement triggered this save - needed for the git-commit job's space context
  title?: string; // UI overhaul A3: title is its own column, NOT part of the Yjs doc / OCC window
  titleProvided?: boolean; // true when the client explicitly sent `title` (title-aware client)
  content: unknown;
  expectedUpdatedAt: Date;
}): Promise<{ ok: true } | { ok: false; conflict: true }> {
  // Phase 1 (§7.12): backfill block ids on the server as a safety net. The
  // live editor always sends id'd content (UniqueID extension), but content
  // that bypassed a live editor - restored Markdown, template/import content,
  // hand-crafted JSON - may not have ids yet, and comments/refs/links rely on
  // them existing for every block.
  const content = ensureBlockIds(opts.content as JSONBlock);

  // Title edits and body edits are independent: the title lives in its own
  // column, so a concurrent title change must not conflict with a body save
  // (and vice versa). The title update therefore runs outside the OCC gate
  // below and does NOT bump updatedAt, so it can't make the body's
  // expectedUpdatedAt check spuriously fail. Body saves own the timestamp.
  if (opts.title !== undefined) {
    await db.update(pages).set({ title: opts.title }).where(eq(pages.id, opts.pageId));
  }

  // A title-aware client (one that sends `title`) echoing the current content
  // back is doing a title-only save: skip the OCC gate entirely so the title
  // update never conflicts with a concurrent body save. The title change still
  // commits to git (the frontmatter title is part of history now). Legacy
  // clients (no `title` in the body) keep the exact old behavior - every save
  // goes through the OCC gate, so a stale duplicate save still 409s.
  if (opts.titleProvided) {
    const [current] = await db.select({ content: pages.content }).from(pages).where(eq(pages.id, opts.pageId));
    const contentUnchanged = current && isDeepStrictEqual(current.content, content);
    if (contentUnchanged) {
      await enqueueJob("git_commit", { pageId: opts.pageId, branchId: opts.branchId, kind: "autosave" });
      return { ok: true };
    }
  }

  const result = await db
    .update(pages)
    .set({ content: content as any, updatedAt: new Date() })
    .where(and(eq(pages.id, opts.pageId), eq(pages.updatedAt, opts.expectedUpdatedAt)));

  // better-sqlite3 via drizzle exposes changes on the raw result
  const changes = (result as unknown as { changes: number }).changes;
  if (changes === 0) return { ok: false, conflict: true };

  await enqueueJob("git_commit", { pageId: opts.pageId, branchId: opts.branchId, kind: "autosave" });
  return { ok: true };
}

export async function createSnapshot(opts: { pageId: string; branchId: string; message: string; userId: string }) {
  await enqueueJob("git_commit", {
    pageId: opts.pageId,
    branchId: opts.branchId,
    kind: "manual_snapshot",
    message: opts.message,
    userId: opts.userId,
  });
}
