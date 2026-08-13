import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { branches, pages } from "../db/schema.js";
import { canViewPage } from "./branch.service.js";
import { listIncomingRelations, listOwnedRelations } from "./relation.service.js";
import { getPageBacklinks, getPageOutgoingLinks } from "./backlink.service.js";
import type { UserContext } from "../../shared/types.js";

/** Node in the local-neighborhood graph (brief §13.2). */
export interface GraphNode {
  id: string;
  title: string;
  /** First readable branchId for the page; null when the caller can't
   *  navigate to it (shouldn't happen since we filter to readable pages,
   *  but the field is nullable for type-safety). */
  branchId: string | null;
  isCenter: boolean;
}

/** Edge in the local-neighborhood graph. Direction is relative to the
 *  center page so the UI can render arrows consistently: "out" means
 *  the center is the source, "in" means the center is the target. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "backlink" | "relation";
  label: string | null;
  direction: "out" | "in";
}

export interface PageGraphResponse {
  center: string;
  hops: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Local-neighborhood graph for `pageId`: nodes = the center plus all
 * pages one hop out (via backlink OR relation), edges = the connecting
 * backlink / relation rows. Defaults to hops=1 (the brief: "Scope it
 * to a single page's local neighborhood by default (its direct
 * links/relations, one hop out) rather than rendering the entire
 * instance's graph at once").
 *
 * Permission boundaries (no existence leak): every node + every edge
 * refers to a page the caller can read; unreadable pages are dropped
 * entirely. If the caller can't read the center page at all, this
 * function still returns a result with one node (the center, with
 * `branchId: null`) and zero edges — callers can use this to render
 * a "page not found" state without leaking that the page exists.
 *
 * For hops > 1 the function descends one level at a time and unions
 * neighbors; the implementation is intentionally simple (no de-dupe
 * of edges across hops, no path tracking) because the brief scopes
 * the typical use to one hop. The `hops` query parameter is exposed
 * so future slices can use it without an API change.
 */
export async function getPageGraph(
  pageId: string,
  caller: UserContext,
  opts: { hops?: number } = {},
): Promise<PageGraphResponse> {
  const hops = Math.min(Math.max(opts.hops ?? 1, 1), 3);
  // We always emit the center node, even if the caller can't read it.
  // The UI shows "page not found" via branchId: null.
  const centerReadable = await canViewPage(caller, pageId);

  const visited = new Set<string>([pageId]);
  const nodesById = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>(); // dedupe (from, to, kind, label)

  // Seed the center node (we always emit it).
  {
    const info = await loadFirstReadableBranch(pageId, caller);
    nodesById.set(pageId, {
      id: pageId,
      title: info?.title ?? "",
      branchId: info?.branchId ?? null,
      isCenter: true,
    });
  }

  // BFS up to `hops`. We only follow edges out of nodes whose page is
  // readable, so an unreadable center stops the walk.
  let frontier: string[] = centerReadable ? [pageId] : [];
  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      const { outgoing, incoming } = await collectNeighbors(nodeId, caller);
      for (const e of outgoing) {
        const key = `${e.from}->${e.to}|${e.kind}|${e.label ?? ""}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push(e);
        if (!visited.has(e.to)) {
          visited.add(e.to);
          nextFrontier.push(e.to);
          const info = await loadFirstReadableBranch(e.to, caller);
          if (info) nodesById.set(e.to, { id: e.to, title: info.title, branchId: info.branchId, isCenter: false });
        }
      }
      for (const e of incoming) {
        const key = `${e.from}->${e.to}|${e.kind}|${e.label ?? ""}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push(e);
        if (!visited.has(e.from)) {
          visited.add(e.from);
          nextFrontier.push(e.from);
          const info = await loadFirstReadableBranch(e.from, caller);
          if (info) nodesById.set(e.from, { id: e.from, title: info.title, branchId: info.branchId, isCenter: false });
        }
      }
    }
    frontier = nextFrontier;
  }

  return {
    center: pageId,
    hops,
    nodes: [...nodesById.values()],
    edges,
  };
}

/** Collect edges adjacent to `nodeId`: outgoing (center -> x) and
 *  incoming (x -> center). Source/target pages the caller can't read
 *  are filtered out by the underlying services, so each edge we get
 *  back has already passed the no-existence-leak filter. */
async function collectNeighbors(
  nodeId: string,
  caller: UserContext,
): Promise<{ outgoing: GraphEdge[]; incoming: GraphEdge[] }> {
  // Outgoing: relations owned by nodeId + backlinks FROM nodeId.
  const [ownedRels, outLinks, incomingRels, inLinks] = await Promise.all([
    listOwnedRelations(nodeId, caller),
    getPageOutgoingLinks(nodeId, caller),
    listIncomingRelations(nodeId, caller),
    getPageBacklinks(nodeId, caller),
  ]);

  const outgoing: GraphEdge[] = [];
  for (const r of ownedRels) {
    if (!r.target) continue;
    outgoing.push({
      id: r.id,
      from: nodeId,
      to: r.target.id,
      kind: "relation",
      label: r.type,
      direction: "out",
    });
  }
  for (const l of outLinks) {
    if (!l.target) continue;
    outgoing.push({
      id: `bl-${l.targetBranchId}-${l.targetBlockId ?? ""}`,
      from: nodeId,
      to: l.target.id,
      kind: "backlink",
      label: null,
      direction: "out",
    });
  }

  const incoming: GraphEdge[] = [];
  for (const r of incomingRels) {
    if (!r.source) continue;
    incoming.push({
      id: r.id,
      from: r.source.id,
      to: nodeId,
      kind: "relation",
      label: r.type,
      direction: "in",
    });
  }
  for (const l of inLinks) {
    // Backlink entry has sourceBranchId + sourcePageId? — `getPageBacklinks`
    // doesn't return sourcePageId directly, but the source is the page
    // that placed the link. We resolve via a quick lookup so the edge
    // node id is a pageId.
    const sourcePageId = await resolveBranchPageId(l.sourceBranchId);
    if (!sourcePageId) continue;
    incoming.push({
      id: `bl-${l.sourceBranchId}-${l.targetBlockId ?? ""}-rev`,
      from: sourcePageId,
      to: nodeId,
      kind: "backlink",
      label: null,
      direction: "in",
    });
  }
  return { outgoing, incoming };
}

/** Look up the page id for a branch id (one row, cheap). */
async function resolveBranchPageId(branchId: string): Promise<string | null> {
  const { db } = getDb();
  const [row] = await db
    .select({ pageId: branches.pageId })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  return row?.pageId ?? null;
}

/** Look up the title and first-readable-branchId for a page. Returns
 *  null when the caller can't read the page at all (no readable branch
 *  in any space they can access). The caller should pass this through
 *  as-is to the response: the node simply isn't emitted. */
async function loadFirstReadableBranch(
  pageId: string,
  caller: UserContext,
): Promise<{ title: string; branchId: string } | null> {
  const { db } = getDb();
  // Title: the page row holds the canonical title.
  const [pageRow] = await db
    .select({ id: pages.id, title: pages.title })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  if (!pageRow) return null;

  // Find all branches of this page.
  const allBranches = await db
    .select({ id: branches.id, spaceId: branches.spaceId })
    .from(branches)
    .where(eq(branches.pageId, pageId));

  if (allBranches.length === 0) {
    // Page exists but has no branches (deleted?). Return title with no
    // branchId so the node still renders, just without a click target.
    return { title: pageRow.title, branchId: "" };
  }

  if (caller.isAdmin) {
    return { title: pageRow.title, branchId: allBranches[0]!.id };
  }

  // Non-admin: only branches in accessible spaces count.
  const { loadAccessibleSpaceIds } = await import("./relation.service.js");
  const accessible = new Set(await loadAccessibleSpaceIds(caller, { editorOnly: false }));
  const branch = allBranches.find((b) => accessible.has(b.spaceId));
  if (!branch) return null;
  return { title: pageRow.title, branchId: branch.id };
}

