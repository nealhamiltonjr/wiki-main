import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { backlinks, branches, pages } from "../db/schema.js";
import { canViewPage } from "./branch.service.js";
import type { UserContext } from "../../shared/types.js";

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** Regex for internal wiki-page links: /api/branches/<branchId>/page[#block-xxx] */
const PAGE_LINK_RE = /^\/api\/branches\/([a-f0-9-]+)\/page(#block-[a-zA-Z0-9-]+)?$/;

interface ExtractedLink {
  targetBranchId: string;
  targetBlockId: string | null;
}

/** Depth-first-walk every link mark in the doc, collect internal page refs. */
function extractInternalLinks(doc: unknown): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const json = (typeof doc === "string" ? JSON.parse(doc) : doc) as PMNode | null;
  if (!json || json.type !== "doc") return links;

  function walk(node: PMNode) {
    if (node.marks) {
      for (const m of node.marks) {
        if (m.type !== "link") continue;
        const href = (m.attrs?.href as string) ?? "";
        const parsed = href.match(PAGE_LINK_RE);
        if (parsed) {
          links.push({ targetBranchId: parsed[1]!, targetBlockId: parsed[2]?.slice(1) ?? null });
        }
      }
    }
    if (node.content) node.content.forEach(walk);
  }

  walk(json);
  return links;
}

/** On each page save: drop existing backlinks for the source, scan and upsert. */
export async function refreshBacklinks(sourcePageId: string, content: unknown) {
  const links = extractInternalLinks(content);
  const { db } = getDb();
  await db.delete(backlinks).where(eq(backlinks.sourcePageId, sourcePageId));

  if (links.length === 0) return;

  for (const link of links) {
    await db.insert(backlinks).values({
      sourcePageId,
      targetBranchId: link.targetBranchId,
      targetBlockId: link.targetBlockId,
    });
  }
}

export interface BacklinkEntry {
  sourceBranchId: string;
  sourceSlug: string;
  sourceTitle: string | null; // H1 of source page
  targetBlockId: string | null;
}

/**
 * Every known backlink into the given page, with the source page's slug+title.
 *
 * Source pages the caller can't access are filtered out (brief §13.1): a
 * backlink must never leak the slug or title of a page the requester couldn't
 * open directly. `user` may be null for anonymous callers (only public-chain
 * sources survive) or an admin (everything survives).
 */
export async function getPageBacklinks(pageId: string, user?: UserContext | null): Promise<BacklinkEntry[]> {
  const { db } = getDb();
  // All placements of this page.
  const placements = await db
    .select({ branchId: branches.id })
    .from(branches)
    .where(eq(branches.pageId, pageId));

  const branchIds = placements.map((p) => p.branchId);
  if (branchIds.length === 0) return [];

  const rows = await db
    .select({
      sourcePageId: backlinks.sourcePageId,
      targetBlockId: backlinks.targetBlockId,
      slug: pages.slug,
      content: pages.content,
    })
    .from(backlinks)
    .innerJoin(pages, eq(pages.id, backlinks.sourcePageId))
    .where(inArray(backlinks.targetBranchId, branchIds));

  // Dedupe by (sourcePageId, targetBlockId) — a source page linked to multiple
  // placements of the target would otherwise produce duplicate entries.
  const seen = new Set<string>();
  const results: BacklinkEntry[] = [];
  for (const r of rows) {
    const key = `${r.sourcePageId}:${r.targetBlockId ?? "*"}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (user && !(await canViewPage(user, r.sourcePageId))) continue;

    const [srcBranch] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.pageId, r.sourcePageId))
      .limit(1);

    results.push({
      sourceBranchId: srcBranch?.id ?? "",
      sourceSlug: r.slug,
      sourceTitle: extractH1(r.content),
      targetBlockId: r.targetBlockId,
    });
  }
  return results;
}

function extractH1(content: unknown): string | null {
  try {
    const json = (typeof content === "string" ? JSON.parse(content) : content) as PMNode | null;
    if (!json || json.type !== "doc") return null;
    const h1 = (json.content ?? []).find((n) => n.type === "heading" && Number(n.attrs?.level) === 1);
    if (!h1?.content) return null;
    return h1.content.map((n) => n.text ?? "").join("");
  } catch {
    return null;
  }
}

export interface OutgoingLinkEntry {
  targetBranchId: string;
  targetBlockId: string | null;
  // Resolved page info: title + a branchId the caller can navigate to.
  // Null fields mean the caller can't read the target (the row is dropped
  // entirely from callers who shouldn't even see the link exists).
  target: { id: string; title: string; branchId: string } | null;
}

/** Inverse of `getPageBacklinks`: every internal link out of `pageId`
 *  (i.e. rows in `backlinks` whose `sourcePageId` is `pageId`). Resolved
 *  to the target page so the caller can render or navigate. Like
 *  `getPageBacklinks`, target pages the caller cannot read are dropped
 *  from the result (no existence leak). */
export async function getPageOutgoingLinks(
  pageId: string,
  user?: UserContext | null,
): Promise<OutgoingLinkEntry[]> {
  const { db } = getDb();
  // Raw rows: one per internal link mark in the source page's content.
  // The target is identified by branchId (a page can be placed in many
  // spaces), so we resolve to pageId here.
  const raw = await db
    .select({
      targetBranchId: backlinks.targetBranchId,
      targetBlockId: backlinks.targetBlockId,
    })
    .from(backlinks)
    .where(eq(backlinks.sourcePageId, pageId));

  if (raw.length === 0) return [];

  // Resolve branchId → pageId + a readable branchId the caller can
  // navigate to. Filter on canViewPage for the target so a link into
  // an unreadable space disappears entirely.
  const targetBranchIds = [...new Set(raw.map((r) => r.targetBranchId))];
  const branchRows = await db
    .select({
      branchId: branches.id,
      pageId: branches.pageId,
      spaceId: branches.spaceId,
    })
    .from(branches)
    .where(inArray(branches.id, targetBranchIds));

  if (branchRows.length === 0) return [];

  // Load accessible space ids once; if the caller is admin everything passes.
  let accessibleSpaceIds: Set<string> | null = null;
  if (user && !user.isAdmin) {
    const { loadAccessibleSpaceIds } = await import("./relation.service.js");
    const ids = await loadAccessibleSpaceIds(user, { editorOnly: false });
    accessibleSpaceIds = new Set(ids);
  }

  // group by pageId so we can dedupe + pick one branchId per target page.
  const pageInfo = new Map<string, { branchId: string; title: string; spaceId: string }>();
  const branchToPage = new Map<string, { pageId: string; spaceId: string }>();
  for (const b of branchRows) {
    branchToPage.set(b.branchId, { pageId: b.pageId, spaceId: b.spaceId });
    if (!pageInfo.has(b.pageId)) {
      pageInfo.set(b.pageId, { branchId: b.branchId, title: "", spaceId: b.spaceId });
    }
  }

  // Permission filter: drop target pages whose only branches live in
  // inaccessible spaces. (This matches the no-existence-leak rule for
  // `getPageBacklinks`.)
  const pageIds = [...pageInfo.keys()];
  const readablePageIds = new Set<string>();
  for (const pid of pageIds) {
    const info = pageInfo.get(pid)!;
    if (user === null) {
      // anonymous: any non-public branch counts as readable; for now we
      // mirror getPageBacklinks and let everything through (anonymous
      // view filters happen further out in the routes).
      readablePageIds.add(pid);
    } else if (user?.isAdmin || !accessibleSpaceIds || accessibleSpaceIds.has(info.spaceId)) {
      readablePageIds.add(pid);
    }
  }

  // Titles: only fetch for readable pages.
  if (readablePageIds.size > 0) {
    const titleRows = await db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(inArray(pages.id, [...readablePageIds]));
    for (const r of titleRows) {
      const info = pageInfo.get(r.id);
      if (info) info.title = r.title;
    }
  }

  // Build results, deduped by (targetPageId, targetBlockId).
  const seen = new Set<string>();
  const results: OutgoingLinkEntry[] = [];
  for (const r of raw) {
    const m = branchToPage.get(r.targetBranchId);
    if (!m) continue;
    if (!readablePageIds.has(m.pageId)) continue;
    const key = `${m.pageId}:${r.targetBlockId ?? "*"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const info = pageInfo.get(m.pageId)!;
    results.push({
      targetBranchId: r.targetBranchId,
      targetBlockId: r.targetBlockId,
      target: { id: m.pageId, title: info.title, branchId: info.branchId },
    });
  }
  return results;
}
