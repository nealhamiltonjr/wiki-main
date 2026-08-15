import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pages, branches, backlinks, pageRedirects } from "../db/schema.js";
import { docToText } from "./search.service.js";

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

export interface BrokenWikilink {
  sourcePageId: string;
  sourceBranchId: string;
  sourceSlug: string;
  sourceTitle: string;
  targetBranchId: string;
  targetBlockId: string | null;
}

export interface SimilarPagePair {
  a: { pageId: string; branchId: string; slug: string; title: string };
  b: { pageId: string; branchId: string; slug: string; title: string };
  /** Dice coefficient over 3-char shingles, 0..1. */
  score: number;
}

export interface MaintenanceReport {
  generatedAt: Date;
  orphanedPages: OrphanedPage[];
  brokenRedirects: BrokenRedirect[];
  brokenWikilinks: BrokenWikilink[];
  similarPages: SimilarPagePair[];
}

const SIMILARITY_THRESHOLD = 0.35;
const MIN_TEXT_LENGTH_FOR_SIMILARITY = 80;

/** 3-char shingles of a normalized text, deduplicated into a Set. */
function shingles(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i++) {
    out.add(normalized.slice(i, i + 3));
  }
  return out;
}

/** Sørensen–Dice coefficient over two shingle sets, 0..1. */
function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const shingle of a) if (b.has(shingle)) intersection++;
  return (2 * intersection) / (a.size + b.size);
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
 *   - brokenWikilinks: backlink rows out of pages in this space whose target
 *     branch no longer exists (or now points at a trashed page). Rows linger
 *     until the source page is re-saved, so the report surfaces them directly.
 *   - similarPages: near-duplicate page pairs detected by trigram similarity
 *     over rendered plain text (no AI/embeddings, no external services).
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

  // All live, non-system pages in this space (needed for outgoing-link source
  // resolution and for plain-text similarity — orphanedPagesRows above omits
  // `content` to keep its projection small).
  const spacePageRows = db
    .select({
      pageId: pages.id,
      branchId: branches.id,
      slug: pages.slug,
      title: pages.title,
      content: pages.content,
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

  // Broken wikilinks: backlink rows out of this space's pages whose target
  // branch no longer resolves to a live, non-system page. Backlinks are only
  // refreshed when the *source* is re-saved, so deleting/trashing a target
  // leaves these rows stale until the report calls them out.
  const sourcePageIds = spacePageRows.map((r) => r.pageId);
  const brokenWikilinks: BrokenWikilink[] = [];
  if (sourcePageIds.length > 0) {
    const outgoingRows = db
      .select({
        sourcePageId: backlinks.sourcePageId,
        targetBranchId: backlinks.targetBranchId,
        targetBlockId: backlinks.targetBlockId,
      })
      .from(backlinks)
      .where(inArray(backlinks.sourcePageId, sourcePageIds))
      .all();

    const targetBranchIds = [...new Set(outgoingRows.map((r) => r.targetBranchId))];
    const liveBranchIds = new Set<string>();
    if (targetBranchIds.length > 0) {
      const targetRows = db
        .select({ branchId: branches.id, deletedAt: pages.deletedAt })
        .from(branches)
        .leftJoin(pages, eq(pages.id, branches.pageId))
        .where(and(inArray(branches.id, targetBranchIds), eq(branches.isSystem, false)))
        .all();
      for (const t of targetRows) {
        if (t.deletedAt === null) liveBranchIds.add(t.branchId);
      }
    }

    const pageById = new Map(spacePageRows.map((r) => [r.pageId, r]));
    for (const r of outgoingRows) {
      if (liveBranchIds.has(r.targetBranchId)) continue;
      const src = pageById.get(r.sourcePageId);
      brokenWikilinks.push({
        sourcePageId: r.sourcePageId,
        sourceBranchId: src?.branchId ?? "",
        sourceSlug: src?.slug ?? "",
        sourceTitle: src?.title ?? "",
        targetBranchId: r.targetBranchId,
        targetBlockId: r.targetBlockId,
      });
    }
  }
  brokenWikilinks.sort(
    (a, b) => a.sourceSlug.localeCompare(b.sourceSlug) || a.targetBranchId.localeCompare(b.targetBranchId),
  );

  // Similar pages: pairwise trigram similarity over rendered plain text.
  // Deliberately no AI/embeddings — a near-duplicate detector that runs with
  // zero external services and reuses docToText from search.
  const similarPages: SimilarPagePair[] = [];
  const withText = spacePageRows
    .map((r) => ({ r, text: docToText(r.content) }))
    .filter((entry) => entry.text.length >= MIN_TEXT_LENGTH_FOR_SIMILARITY);
  if (withText.length >= 2) {
    const cached = withText.map((entry) => ({ entry, set: shingles(entry.text) }));
    for (let i = 0; i < cached.length; i++) {
      const left = cached[i];
      if (!left) continue;
      for (let j = i + 1; j < cached.length; j++) {
        const right = cached[j];
        if (!right) continue;
        const score = diceSimilarity(left.set, right.set);
        if (score < SIMILARITY_THRESHOLD) continue;
        const a = left.entry.r;
        const b = right.entry.r;
        similarPages.push({
          a: { pageId: a.pageId, branchId: a.branchId, slug: a.slug, title: a.title },
          b: { pageId: b.pageId, branchId: b.branchId, slug: b.slug, title: b.title },
          score: Number(score.toFixed(3)),
        });
      }
    }
  }
  similarPages.sort((x, y) => y.score - x.score || x.a.slug.localeCompare(y.a.slug));

  return {
    generatedAt: new Date(),
    orphanedPages,
    brokenRedirects,
    brokenWikilinks,
    similarPages,
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
