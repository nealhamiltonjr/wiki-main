import type { FastifyInstance } from "fastify";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { favorites, pages, branches } from "../db/schema.js";
import type { UserContext } from "../../shared/types.js";

export async function favoriteRoutes(app: FastifyInstance) {
  // List current user's favorites with page info.
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
      return reply.send(rows);
    }
  );

  // Toggle favorite: add if absent, remove if present.
  app.post(
    "/api/favorites/:branchId",
    { config: { access: "authenticated" } },
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
