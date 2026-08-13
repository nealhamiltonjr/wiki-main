import type { FastifyInstance } from "fastify";
import { canViewPage } from "../services/branch.service.js";
import { getPageGraph } from "../services/graph.service.js";
import type { UserContext } from "../../shared/types.js";

/** Brief §13.2: graph view of a page's local neighborhood. Reads the
 *  same backlinks / relations index as §9 and §13.1 — purely a
 *  presentation layer over data that already exists. */
export async function graphRoutes(app: FastifyInstance) {
  app.get<{ Params: { pageId: string }; Querystring: { hops?: string } }>(
    "/api/pages/:pageId/graph",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = (request as { userContext?: UserContext }).userContext;
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      // 404 on unreadable center so we don't leak its existence.
      if (!(await canViewPage(u, request.params.pageId))) {
        return reply.code(404).send({ error: "page not found" });
      }
      const hops = clampHops(request.query.hops);
      const graph = await getPageGraph(request.params.pageId, u, { hops });
      return reply.send(graph);
    },
  );
}

function clampHops(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), 3);
}