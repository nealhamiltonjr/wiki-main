import type { FastifyInstance } from "fastify";
import { searchPages, searchSpaces } from "../services/search.service.js";

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/api/search",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      try {
        const query = request.query as { q?: string; spaceId?: string };
        if (!query.q?.trim()) return reply.send({ results: [], spaces: [], count: 0 });
        const results = searchPages(query.q, query.spaceId);
        const spaces = searchSpaces(query.q);
        return reply.send({ results, spaces, count: results.length });
      } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: "Search failed" });
      }
    }
  );
}
