import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTemplate, listTemplatesForUser, deleteTemplate } from "../services/template.service.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";

const createTemplateBody = z.object({
  pageId: z.string(),
  sourceBranchId: z.string(), // used to permission-check the source page - templates.pageId itself has no branch to check against
  name: z.string().min(1),
  scope: z.enum(["global", "user"]),
});

export async function templateRoutes(app: FastifyInstance) {
  app.get("/api/templates", { config: { access: "authenticated" } }, async (request, reply) => {
    const user = (request as any).userContext;
    return reply.send(await listTemplatesForUser(user.id));
  });

  // A template's underlying page can live anywhere - the permission check is
  // done against the branch the caller used to reach it (same principle as
  // file serving, §3.13a: check the specific placement, not the bare page).
  app.post("/api/templates", { config: { access: "authenticated" } }, async (request, reply) => {
    const body = createTemplateBody.parse(request.body);
    const user = (request as any).userContext;

    const chain = await getBranchChain(body.sourceBranchId).catch(() => null);
    if (!chain) return reply.code(404).send({ error: "Source branch not found" });
    const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
    const access = resolveAccess(user, chain, spaceRole);
    if (access !== "editor" && access !== "admin") {
      return reply.code(403).send({ error: "Insufficient permissions on the source page" });
    }
    // Global templates require admin - a regular editor can only save a personal template.
    if (body.scope === "global" && !user.isAdmin) {
      return reply.code(403).send({ error: "Only admins can create global templates" });
    }

    const result = await createTemplate({ pageId: body.pageId, name: body.name, scope: body.scope, createdBy: user.id });
    return reply.code(201).send(result);
  });

  app.delete("/api/templates/:id", { config: { access: "authenticated" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).userContext;
    const result = await deleteTemplate(id, user.id, user.isAdmin);
    if (!result.ok) {
      return reply.code(result.reason === "not_found" ? 404 : 403).send({ error: result.reason });
    }
    return reply.code(204).send();
  });
}
