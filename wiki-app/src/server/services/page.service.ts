import { eq, and, sql } from "drizzle-orm";
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
  content: unknown;
  expectedUpdatedAt: Date;
}): Promise<{ ok: true } | { ok: false; conflict: true }> {
  // Phase 1 (§7.12): backfill block ids on the server as a safety net. The
  // live editor always sends id'd content (UniqueID extension), but content
  // that bypassed a live editor - restored Markdown, template/import content,
  // hand-crafted JSON - may not have ids yet, and comments/refs/links rely on
  // them existing for every block.
  const content = ensureBlockIds(opts.content as JSONBlock);
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
