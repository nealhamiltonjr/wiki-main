import type { FastifyInstance } from "fastify";
import { getRepoStatus, getRepoLog } from "../services/git.service.js";

/**
 * Admin git section (§8 step 10). Status/log are cheap and read-only — the
 * write path (autosave + manual snapshots) runs through the commit queue.
 * Remote push/pull land with the settings slice.
 */
export async function gitRoutes(app: FastifyInstance) {
  app.get("/api/git/status", { config: { access: "admin" } }, async (_request, reply) => {
    return reply.send(await getRepoStatus());
  });

  app.get("/api/git/log", { config: { access: "admin" } }, async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    const n = Math.min(Math.max(parseInt(limit ?? "25", 10) || 25, 1), 200);
    return reply.send(await getRepoLog(n));
  });
}
