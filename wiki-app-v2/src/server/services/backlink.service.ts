import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { backlinks, branches, pages } from "../db/schema.js";

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

/** Every known backlink into the given page, with the source page's slug+title. */
export async function getPageBacklinks(pageId: string): Promise<BacklinkEntry[]> {
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
