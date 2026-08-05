import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listGroups, createGroup, deleteGroup, listGroupMembers, addGroupMember, removeGroupMember, updateGroupCapabilities } from "../services/group.service.js";

const createGroupBody = z.object({ name: z.string().min(1), capabilities: z.array(z.string()).optional() });
const capabilitiesBody = z.object({ capabilities: z.array(z.string()) });
const memberBody = z.object({ userId: z.string() });

export async function groupRoutes(app: FastifyInstance) {
  app.get("/api/groups", { config: { access: "admin" } }, async (_request, reply) => {
    return reply.send(await listGroups());
  });

  app.post("/api/groups", { config: { access: "admin" } }, async (request, reply) => {
    const body = createGroupBody.parse(request.body);
    return reply.code(201).send(await createGroup(body.name, body.capabilities));
  });

  app.put("/api/groups/:id/capabilities", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = capabilitiesBody.parse(request.body);
    await updateGroupCapabilities(id, body.capabilities);
    return reply.send({ ok: true });
  });

  app.delete("/api/groups/:id", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteGroup(id);
    return reply.code(204).send();
  });

  app.get("/api/groups/:id/members", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await listGroupMembers(id));
  });

  app.post("/api/groups/:id/members", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = memberBody.parse(request.body);
    await addGroupMember(id, body.userId);
    return reply.code(204).send();
  });

  app.delete("/api/groups/:id/members/:userId", { config: { access: "admin" } }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    await removeGroupMember(id, userId);
    return reply.code(204).send();
  });
}
