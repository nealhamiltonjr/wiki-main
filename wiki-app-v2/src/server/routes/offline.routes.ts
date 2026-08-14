import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pinnedPages, pages, branches } from "../db/schema.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { UserContext } from "../../shared/types.js";

/**
 * Brief §12.5 — "Offline readability for the pages that matter most". A
 * pinned page is just a per-user bookmark that the client-side service
 * worker caches after a successful read. The server stays the source of
 * truth: pin = permission check (viewer+), then write to `pinned_pages`.
 *
 * The route shape deliberately mirrors `favorite.routes.ts` so the UI can
 * reuse the same toggle pattern.
 */
export async function offlineRoutes(app: FastifyInstance) {
  // List current user's pinned pages. Pins to branches the user has lost
  // access to are dropped — a pin must not resurrect metadata about a
  // page the user can no longer read.
  app.get(
    "/api/pinned",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const { db } = getDb();
      const rows = await db
        .select({
          id: pinnedPages.id,
          branchId: pinnedPages.branchId,
          slug: pages.slug,
          title: pages.title,
          pinnedAt: pinnedPages.createdAt,
        })
        .from(pinnedPages)
        .innerJoin(branches, eq(branches.id, pinnedPages.branchId))
        .innerJoin(pages, eq(pages.id, branches.pageId))
        .where(eq(pinnedPages.userId, user.id))
        .orderBy(desc(pinnedPages.createdAt));

      const results = [];
      for (const r of rows) {
        const chain = await getBranchChain(r.branchId).catch(() => null);
        if (!chain) continue;
        if (user.isAdmin) { results.push(r); continue; }
        const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
        if (resolveAccess(user, chain, spaceRole) !== "none") results.push(r);
      }
      return reply.send(results);
    }
  );

  // Toggle pin: add if absent, remove if present. Requires viewer access
  // on the branch — you can't pin a page you can't see.
  app.post(
    "/api/pinned/:branchId",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const { branchId } = request.params as { branchId: string };

      const { db } = getDb();
      const [existing] = await db
        .select()
        .from(pinnedPages)
        .where(and(eq(pinnedPages.userId, user.id), eq(pinnedPages.branchId, branchId)));

      if (existing) {
        await db.delete(pinnedPages).where(eq(pinnedPages.id, existing.id));
        return reply.send({ pinned: false });
      }

      await db.insert(pinnedPages).values({ userId: user.id, branchId } as never);
      return reply.send({ pinned: true });
    }
  );
}