import type { FastifyInstance } from "fastify";
import { searchPages } from "../services/search.service.js";

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/api/search",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      try {
        const query = request.query as { q?: string; spaceId?: string };
        if (!query.q?.trim()) return reply.send({ results: [] });
        const results = searchPages(query.q, query.spaceId);
        return reply.send({ results });
      } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: "Search failed" });
      }
    }
  );
}
