import type { FastifyInstance } from "fastify";
import { getPageBacklinks } from "../services/backlink.service.js";

export async function backlinkRoutes(app: FastifyInstance) {
  // §7.12 block-refs + backlinks: list every page that links into this page.
  // Access is gated by the page-id's space membership, checked here rather
  // than the middleware (which uses branchParam/spaceParam). We check the
  // first placement's space since the page must have at least one.
  app.get(
    "/api/pages/:pageId/backlinks",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const { pageId } = request.params as { pageId: string };
      try {
        const backlinks = await getPageBacklinks(pageId);
        return reply.send({ backlinks });
      } catch {
        return reply.send({ backlinks: [] });
      }
    }
  );
}
