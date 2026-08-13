import { eq, and, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pages, branches, backlinks, pageRedirects } from "../db/schema.js";

export interface OrphanedPage {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  updatedAt: Date;
}

export interface BrokenRedirect {
  spaceId: string;
  oldSlug: string;
  pageId: string;
  /** Why the redirect is broken: "deleted" if the target page is in trash, "missing" if removed from this space. */
  reason: "deleted" | "missing";
  /** The live slug of the target page if it's still alive somewhere (just not in this space). */
  currentSlug: string;
  /** The page's title (if it exists). */
  title: string;
}

export interface MaintenanceReport {
  generatedAt: Date;
  orphanedPages: OrphanedPage[];
  brokenRedirects: BrokenRedirect[];
}

/**
 * Build a maintenance report for a single space (brief §12.7).
 *
 * Always defined as a single space scope — the brief's target user is the
 * personal wiki operator doing an occasional five-minute cleanup pass; a
 * global report gets unreadable fast as the wiki grows, and a single page
 * already gives them something useful to act on.
 *
 * Categories:
 *   - orphanedPages: pages placed in this space with no incoming backlinks
 *     (no other page in the wiki references them). Excludes the system
 *     Trash branch and any page currently in trash.
 *   - brokenRedirects: page_redirects whose target page is either in trash
 *     (deletedAt !== null) or no longer has a non-system branch in this
 *     space. The resolver already returns 404 for both cases — this list
 *     lets the operator prune them so the alias table doesn't accumulate.
 */
export async function buildMaintenanceReport(spaceId: string): Promise<MaintenanceReport> {
  const { db } = getDb();

  const orphanedPagesRows = db
    .select({
      pageId: pages.id,
      branchId: branches.id,
      slug: pages.slug,
      title: pages.title,
      updatedAt: pages.updatedAt,
    })
    .from(branches)
    .innerJoin(pages, eq(pages.id, branches.pageId))
    .where(
      and(
        eq(branches.spaceId, spaceId),
        eq(branches.isSystem, false),
        isNull(pages.deletedAt)
      )
    )
    .all();

  const referencedPageIds = new Set(
    db
      .selectDistinct({ targetPageId: sql<string>`${branches.pageId}` })
      .from(backlinks)
      .innerJoin(branches, eq(branches.id, backlinks.targetBranchId))
      .where(eq(branches.spaceId, spaceId))
      .all()
      .map((r) => r.targetPageId)
  );

  const orphanedPages: OrphanedPage[] = orphanedPagesRows
    .filter((r) => !referencedPageIds.has(r.pageId))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const aliasRows = db
    .select({
      spaceId: pageRedirects.spaceId,
      oldSlug: pageRedirects.oldSlug,
      pageId: pageRedirects.pageId,
      currentSlug: pages.slug,
      deletedAt: pages.deletedAt,
      title: pages.title,
    })
    .from(pageRedirects)
    .innerJoin(pages, eq(pages.id, pageRedirects.pageId))
    .where(eq(pageRedirects.spaceId, spaceId))
    .all();

  const brokenRedirects: BrokenRedirect[] = [];
  for (const a of aliasRows) {
    if (a.oldSlug === a.currentSlug) continue; // stale row whose slug was rolled back to the live one
    if (a.deletedAt !== null) {
      brokenRedirects.push({
        spaceId: a.spaceId,
        oldSlug: a.oldSlug,
        pageId: a.pageId,
        reason: "deleted",
        currentSlug: a.currentSlug,
        title: a.title,
      });
      continue;
    }
    const stillPlaced = db
      .select({ branchId: branches.id })
      .from(branches)
      .where(and(eq(branches.pageId, a.pageId), eq(branches.spaceId, spaceId), eq(branches.isSystem, false)))
      .limit(1)
      .all();
    if (!stillPlaced[0]) {
      brokenRedirects.push({
        spaceId: a.spaceId,
        oldSlug: a.oldSlug,
        pageId: a.pageId,
        reason: "missing",
        currentSlug: a.currentSlug,
        title: a.title,
      });
    }
  }

  brokenRedirects.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "deleted" ? -1 : 1;
    return a.oldSlug.localeCompare(b.oldSlug);
  });

  return {
    generatedAt: new Date(),
    orphanedPages,
    brokenRedirects,
  };
}

/** Delete a single stale alias. The companion mutation to the report. */
export async function deleteAlias(spaceId: string, oldSlug: string): Promise<boolean> {
  const { db } = getDb();
  const deleted = await db
    .delete(pageRedirects)
    .where(and(eq(pageRedirects.spaceId, spaceId), eq(pageRedirects.oldSlug, oldSlug)))
    .run();
  return ((deleted as unknown as { changes: number }).changes ?? 0) > 0;
}
