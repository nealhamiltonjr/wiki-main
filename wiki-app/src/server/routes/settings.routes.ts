import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listSettings, setSetting, deleteSetting } from "../services/settings.service.js";

const setSettingBody = z.object({ value: z.unknown(), isSecret: z.boolean().default(false) });

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", { config: { access: "admin" } }, async (_request, reply) => {
    return reply.send(await listSettings());
  });

  app.put("/api/settings/:key", { config: { access: "admin" } }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = setSettingBody.parse(request.body);
    const user = (request as any).userContext;
    await setSetting(key, body.value, body.isSecret, user.id);
    return reply.code(204).send();
  });

  app.delete("/api/settings/:key", { config: { access: "admin" } }, async (request, reply) => {
    const { key } = request.params as { key: string };
    await deleteSetting(key);
    return reply.code(204).send();
  });
}
