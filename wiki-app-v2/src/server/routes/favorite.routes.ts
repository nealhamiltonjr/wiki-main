import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { favorites, pages, branches } from "../db/schema.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { UserContext } from "../../shared/types.js";

export async function favoriteRoutes(app: FastifyInstance) {
  // List current user's favorites with page info. Favorites whose branch the
  // user can no longer read are dropped — a favorite must not resurrect a page
  // (its slug/title) the user's access no longer covers.
  app.get(
    "/api/favorites",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const { db } = getDb();
      const rows = await db
        .select({
          id: favorites.id,
          branchId: favorites.branchId,
          slug: pages.slug,
          title: pages.title,
        })
        .from(favorites)
        .innerJoin(branches, eq(branches.id, favorites.branchId))
        .innerJoin(pages, eq(pages.id, branches.pageId))
        .where(eq(favorites.userId, user.id))
        .orderBy(desc(favorites.createdAt));

      const results = [];
      for (const r of rows) {
        const chain = await getBranchChain(r.branchId).catch(() => null);
        if (!chain) continue; // branch deleted — drop
        if (user.isAdmin) { results.push(r); continue; }
        const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
        if (resolveAccess(user, chain, spaceRole) !== "none") results.push(r);
      }
      return reply.send(results);
    }
  );

  // Toggle favorite: add if absent, remove if present. Requires viewer access
  // on the branch — you can't favorite a page you can't see.
  app.post(
    "/api/favorites/:branchId",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const { branchId } = request.params as { branchId: string };

      const { db } = getDb();
      const [existing] = await db
        .select()
        .from(favorites)
        .where(and(eq(favorites.userId, user.id), eq(favorites.branchId, branchId)));

      if (existing) {
        await db.delete(favorites).where(eq(favorites.id, existing.id));
        return reply.send({ favorited: false });
      }

      await db.insert(favorites).values({ userId: user.id, branchId } as never);
      return reply.send({ favorited: true });
    }
  );
}
