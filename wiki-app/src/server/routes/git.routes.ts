import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRepoStatus, getRepoLog, testRemote } from "../services/git.service.js";
import { enqueueJob } from "../queue/index.js";

const pushBody = z.object({ force: z.boolean().default(false) });

/**
 * Git section routes (§7.10c). Status/log are cheap and read-only; every
 * destructive or long-running operation (push, pull-import) runs through the
 * worker queue so it never blocks an HTTP request and gets retry/backoff.
 * The "never auto-push" safeguard lives in the UI: nothing here fires without
 * an explicit admin action.
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

  app.post("/api/git/test-remote", { config: { access: "admin" } }, async (_request, reply) => {
    return reply.send(await testRemote());
  });

  app.post("/api/git/push", { config: { access: "admin" } }, async (request, reply) => {
    const body = pushBody.parse(request.body);
    await enqueueJob("git_push", { force: body.force });
    return reply.send({ queued: true });
  });

  app.post("/api/git/pull", { config: { access: "admin" } }, async (_request, reply) => {
    await enqueueJob("git_pull", {});
    return reply.send({ queued: true });
  });
}
