import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listSettings, setSetting, deleteSetting, getSettingValue } from "../services/settings.service.js";
import { validateSettingValue } from "../../shared/settings.js";
import "../../shared/settings-registry.js";
import { resetMailer } from "../services/mailer.service.js";

const MASK = "••••••••";

const setSettingBody = z.object({ value: z.unknown(), isSecret: z.boolean().default(false) });

// Keys whose change requires a live re-init of a cached consumer.
const RUNTIME_EFFECTS = new Set(["smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from"]);

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", { config: { access: "admin" } }, async (_request, reply) => {
    return reply.send(await listSettings());
  });

  app.put("/api/settings/:key", { config: { access: "admin" } }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = setSettingBody.parse(request.body);
    const user = (request as any).userContext;

    const error = validateSettingValue(key, body.value);
    if (error) return reply.code(400).send({ error });

    // A masked secret in the payload means "leave the stored value unchanged".
    let value = body.value;
    if (body.value === MASK) {
      const existing = await getSettingValue(key);
      if (existing === null) return reply.code(400).send({ error: "No stored value to keep" });
      value = existing;
    }

    await setSetting(key, value, body.isSecret, user.id);

    if (RUNTIME_EFFECTS.has(key)) resetMailer();
    return reply.code(204).send();
  });

  app.delete("/api/settings/:key", { config: { access: "admin" } }, async (request, reply) => {
    const { key } = request.params as { key: string };
    await deleteSetting(key);
    if (RUNTIME_EFFECTS.has(key)) resetMailer();
    return reply.code(204).send();
  });
}
