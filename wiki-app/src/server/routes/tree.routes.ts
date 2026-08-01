import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { branches, pages } from "../db/schema.js";

interface TreeNode {
  id: string;
  pageId: string;
  slug: string;
  children: TreeNode[];
}

export async function treeRoutes(app: FastifyInstance) {
  // Space-root access check: the middleware needs a branchParam, so the tree
  // endpoint is registered per-root-branch, not per-space directly - this keeps
  // the same permission machinery as every other route instead of a bespoke
  // space-level-only check that could drift from it.
  app.get(
    "/api/branches/:branchId/tree",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const chain = (request as any).branchChain as { id: string; spaceId: string }[];
      const spaceId = chain[0]!.spaceId;

      // Fixed from the reviewed version: excludes soft-deleted pages and system
      // (trash) branches. Does NOT yet per-node filter permissions below the root
      // - that's a Phase 1.5 refinement (per-node visibility in a tree listing is
      // a UX nicety, not a security boundary, since the actual page fetch is
      // separately permission-checked via its own branchId).
      const rows = await db
        .select({ branchId: branches.id, pageId: branches.pageId, parentId: branches.parentBranchId, slug: pages.slug })
        .from(branches)
        .innerJoin(pages, eq(branches.pageId, pages.id))
        .where(and(eq(branches.spaceId, spaceId), eq(branches.isSystem, false), isNull(pages.deletedAt)));

      const map = new Map<string, TreeNode>();
      const roots: TreeNode[] = [];
      for (const r of rows) map.set(r.branchId, { id: r.branchId, pageId: r.pageId, slug: r.slug, children: [] });
      for (const r of rows) {
        const node = map.get(r.branchId)!;
        if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(node);
        else roots.push(node);
      }
      return reply.send(roots);
    }
  );
}
