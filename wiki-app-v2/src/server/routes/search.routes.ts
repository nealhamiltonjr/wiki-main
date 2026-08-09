import type { FastifyInstance } from "fastify";
import { searchPages, searchSpaces } from "../services/search.service.js";
import type { UserContext } from "../../shared/types.js";

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/api/search",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const query = request.query as { q?: string; spaceId?: string; limit?: string };
      if (!query.q?.trim()) return reply.send({ results: [], spaces: [], count: 0 });
      const user = (request as any).userContext as UserContext;
      const limit = Math.min(Math.max(parseInt(query.limit ?? "25", 10) || 25, 1), 100);
      // Permission filtering happens inside searchPages()/searchSpaces() -
      // they never return a row for a branch/space this user can't actually
      // read, so there's nothing further to check here.
      const results = await searchPages(query.q, user, { spaceId: query.spaceId, limit });
      const spaces = await searchSpaces(query.q, user);
      return reply.send({ results, spaces, count: results.length });
    }
  );
}
