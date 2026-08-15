import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getDebugConfig,
  getDebugEvents,
  buildDebugZip,
  setDebugCaptureEnabled,
  setDebugRedact,
} from "../services/debug-capture.service.js";

const debugBody = z.object({
  enabled: z.boolean().optional(),
  redactUserData: z.boolean().optional(),
}).strict();

/**
 * Slice 35 — debug capture surface (admin-only). Toggle capture on/off and
 * download the in-memory ring buffer as a zip. The capture itself is additive
 * infrastructure; nothing here changes app behavior.
 */
export async function debugRoutes(app: FastifyInstance) {
  app.get("/api/debug", { config: { access: "admin" } }, async (_request, reply) => {
    return reply.send({ ...getDebugConfig(), events: getDebugEvents() });
  });

  app.put("/api/debug", { config: { access: "admin" } }, async (request, reply) => {
    const body = debugBody.parse(request.body);
    if (body.enabled !== undefined) setDebugCaptureEnabled(body.enabled);
    if (body.redactUserData !== undefined) setDebugRedact(body.redactUserData);
    return reply.send(getDebugConfig());
  });

  app.get("/api/debug/export.zip", { config: { access: "admin" } }, async (_request, reply) => {
    const zip = buildDebugZip();
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", 'attachment; filename="debug-capture.zip"');
    return reply.send(Buffer.from(zip));
  });
}
