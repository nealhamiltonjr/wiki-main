import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { attributes, branches, pages } from "../db/schema.js";
import { canViewPage } from "./branch.service.js";
import type { UserContext } from "../../shared/types.js";

/**
 * Template attribute inheritance — brief §13.3.
 *
 * Model: a page declares a template via a relation attribute with
 * `name: "template"` and `valuePageId` pointing at the template page.
 * (This matches the §13.1 typed-relation shape, and it matches
 * Trilium's model.) At read time, the page inherits the union of
 * attributes from its full template chain.
 *
 * Conflict rule: a page's own attributes always win over any template's
 * attributes with the same `name`. Among multiple templates, the first
 * template in the order returned by the database wins on conflict.
 *
 * Safety:
 *   - Cycle-safe via visited set (a chain A→B→A is dropped silently).
 *   - Depth-limited (DEFAULT_MAX_DEPTH=8) so a pathological chain can't
 *     OOM the resolver.
 *   - Permission-filtered: any template page the caller cannot read is
 *     dropped from the chain entirely. This matches the no-existence-leak
 *     rule the rest of the project follows (graph, backlinks, relations).
 */

/** Hard cap on template-chain depth. Even an honest use case rarely
 *  goes past 2-3 levels; this is just a backstop against runaway
 *  inheritance / cycles. */
export const DEFAULT_MAX_DEPTH = 8;

export interface TemplateAttribute {
  id: string;
  pageId: string;
  name: string;
  value: string;
  valuePageId: string | null;
  isPromoted: boolean;
  position: number;
  /** Where this attribute was inherited from. Null on the page's own
   *  attributes (which never appear in the inherited list). */
  templatePageId: string;
  templateTitle: string;
  /** How deep this template sits in the chain (1 = direct template,
   2 = template of template, etc.). */
  depth: number;
}

export interface DirectTemplate {
  pageId: string;
  title: string;
  /** BranchId the caller can navigate to. Null if none of this template's
   *  placements are readable by the caller (shouldn't happen since we
   *  permission-filter upstream, but defensive). */
  branchId: string | null;
  /** Position from the attributes row — preserves user-visible order. */
  position: number;
}

/** Pure resolver logic exported for unit testing — given already-loaded
 *  graph data, compute the merged attribute set. The DB-driven wrapper
 *  `resolveInheritedAttributes` does the actual queries. */
export function mergeInheritedAttributes(
  ownAttrs: TemplateAttribute[],
  templateEntries: Array<{
    templatePageId: string;
    templateTitle: string;
    depth: number;
    attributes: TemplateAttribute[];
  }>,
): TemplateAttribute[] {
  // Templates are processed in the supplied order. The first template's
  // attribute wins on conflict; subsequent templates and the page's
  // own attributes can override earlier ones.
  const byName = new Map<string, TemplateAttribute>();

  for (const t of templateEntries) {
    for (const a of t.attributes) {
      if (byName.has(a.name)) continue; // first template wins
      byName.set(a.name, {
        ...a,
        depth: t.depth,
        templatePageId: t.templatePageId,
        templateTitle: t.templateTitle,
      });
    }
  }
  for (const a of ownAttrs) {
    // Page's own attribute always wins — drop any inherited one with
    // the same name. We never add an inherited marker to own attrs.
    byName.delete(a.name);
    byName.set(a.name, a);
  }

  // Return in deterministic order: by template depth ascending, then
  // position ascending, then name for stability.
  return [...byName.values()].sort((x, y) => {
    if (x.depth !== y.depth) return x.depth - y.depth;
    if (x.position !== y.position) return x.position - y.position;
    return x.name.localeCompare(y.name);
  });
}

/** Walk the template chain for `pageId`, returning the merged set of
 *  inherited attributes plus the direct-template list. Both are
 *  permission-filtered through `user`. */
export async function resolveInheritedAttributes(
  pageId: string,
  user: UserContext | null,
  opts: { maxDepth?: number } = {},
): Promise<{
  directTemplates: DirectTemplate[];
  inheritedAttributes: TemplateAttribute[];
}> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const { db } = getDb();

  // 1. Own template attributes (page → template relations).
  const ownRows = await db
    .select()
    .from(attributes)
    .where(eq(attributes.pageId, pageId));

  const directTemplateRows = ownRows.filter(
    (a) => a.name === "template" && a.valuePageId !== null,
  ) as Array<{
    id: string;
    name: "template";
    valuePageId: string;
    position: number;
  }>;

  if (directTemplateRows.length === 0) {
    return { directTemplates: [], inheritedAttributes: [] };
  }

  // 2. Permission filter on direct templates. If the caller can't read
  // a template page, drop it entirely (no existence leak).
  const directPageIds = [...new Set(directTemplateRows.map((r) => r.valuePageId!))];
  const readableDirect: string[] = [];
  for (const tp of directPageIds) {
    if (await canViewPage(user, tp)) readableDirect.push(tp);
  }
  if (readableDirect.length === 0) {
    return { directTemplates: [], inheritedAttributes: [] };
  }

  // 3. Load direct-template metadata (title + a branchId).
  const directMeta = await loadTemplateMeta(readableDirect);

  // 4. BFS over template chains. Each entry: { pageId, depth }.
  const visited = new Set<string>([pageId]);
  const queue: Array<{ pageId: string; depth: number }> = readableDirect
    .filter((id) => !visited.has(id))
    .map((id) => ({ pageId: id, depth: 1 }));
  for (const id of readableDirect) visited.add(id);

  const templateChain: Array<{
    templatePageId: string;
    templateTitle: string;
    depth: number;
    attributes: TemplateAttribute[];
  }> = [];

  while (queue.length > 0) {
    const head = queue.shift()!;
    if (head.depth > maxDepth) continue;

    const meta = await loadTemplateMeta([head.pageId]);
    const tplTitle = meta.get(head.pageId)?.title ?? "(unknown)";
    const tplAttrs = await db
      .select()
      .from(attributes)
      .where(eq(attributes.pageId, head.pageId));

    const nonRelationAttrs: TemplateAttribute[] = [];
    const childTemplatePageIds: string[] = [];
    for (const a of tplAttrs) {
      if (a.name === "template" && a.valuePageId) {
        childTemplatePageIds.push(a.valuePageId);
        continue;
      }
      nonRelationAttrs.push({
        id: a.id,
        pageId: a.pageId,
        name: a.name,
        value: a.value,
        valuePageId: a.valuePageId,
        isPromoted: a.isPromoted,
        position: a.position,
        templatePageId: head.pageId,
        templateTitle: tplTitle,
        depth: head.depth,
      });
    }

    templateChain.push({
      templatePageId: head.pageId,
      templateTitle: tplTitle,
      depth: head.depth,
      attributes: nonRelationAttrs,
    });

    if (head.depth < maxDepth) {
      const unvisited = childTemplatePageIds.filter((id) => !visited.has(id));
      for (const id of unvisited) {
        if (await canViewPage(user, id)) {
          visited.add(id);
          queue.push({ pageId: id, depth: head.depth + 1 });
        }
      }
    }
  }

  // 5. Build the page's own (non-template) attributes for the merge step.
  const ownNonTemplate = ownRows
    .filter((a) => !(a.name === "template" && a.valuePageId))
    .map(
      (a): TemplateAttribute => ({
        id: a.id,
        pageId: a.pageId,
        name: a.name,
        value: a.value,
        valuePageId: a.valuePageId,
        isPromoted: a.isPromoted,
        position: a.position,
        templatePageId: pageId,
        templateTitle: "",
        depth: 0,
      }),
    );

  const merged = mergeInheritedAttributes(ownNonTemplate, templateChain);

  // Drop the page's own attributes from the inherited view — those
  // surface separately on `GET /api/branches/.../page` already.
  const inheritedOnly = merged.filter((a) => a.templatePageId !== pageId);

  // 6. Build directTemplates in user-visible position order.
  const directTemplates: DirectTemplate[] = directTemplateRows
    .filter((r) => readableDirect.includes(r.valuePageId!))
    .map((r) => {
      const meta = directMeta.get(r.valuePageId!);
      return {
        pageId: r.valuePageId!,
        title: meta?.title ?? "(unknown)",
        branchId: meta?.branchId ?? null,
        position: r.position,
      };
    })
    .sort((a, b) => a.position - b.position);

  return { directTemplates, inheritedAttributes: inheritedOnly };
}

/** Internal: load title + a branchId for a set of page IDs. The
 *  branchId is just any placement — the caller still has to pass
 *  access checks when they navigate. */
async function loadTemplateMeta(
  pageIds: string[],
): Promise<Map<string, { title: string; branchId: string | null }>> {
  const out = new Map<string, { title: string; branchId: string | null }>();
  if (pageIds.length === 0) return out;
  const { db } = getDb();

  const pageRows = await db
    .select({ id: pages.id, title: pages.title })
    .from(pages)
    .where(inArray(pages.id, pageIds));
  const branchRows = await db
    .select({ pageId: branches.pageId, branchId: branches.id })
    .from(branches)
    .where(inArray(branches.pageId, pageIds));

  const branchIdByPage = new Map<string, string>();
  for (const r of branchRows) {
    if (!branchIdByPage.has(r.pageId)) branchIdByPage.set(r.pageId, r.branchId);
  }
  for (const p of pageRows) {
    out.set(p.id, { title: p.title, branchId: branchIdByPage.get(p.id) ?? null });
  }
  return out;
}