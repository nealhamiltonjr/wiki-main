import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listUserSettings, setUserSetting } from "../services/user-settings.service.js";

const setBody = z.object({ value: z.unknown() });

export async function userSettingsRoutes(app: FastifyInstance) {
  app.get("/api/user-settings", { config: { access: "authenticated" } }, async (request, reply) => {
    const user = (request as any).userContext;
    return reply.send(await listUserSettings(user.id));
  });

  app.put("/api/user-settings/:key", { config: { access: "authenticated" } }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = setBody.parse(request.body);
    const user = (request as any).userContext;
    await setUserSetting(user.id, key, body.value);
    return reply.code(204).send();
  });
}
