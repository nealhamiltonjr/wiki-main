import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { auditLog, groups, userGroups } from "../db/schema.js";
import {
  createGroup,
  deleteGroup,
  updateGroupCapabilities,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
} from "../services/group.service.js";

const createGroupBody = z.object({
  name: z.string().min(1).max(100),
  capabilities: z.array(z.string()).optional(),
}).strict();

const updateGroupBody = z.object({
  name: z.string().min(1).max(100).optional(),
  capabilities: z.array(z.string()).optional(),
}).strict();

const addMemberBody = z.object({ userId: z.string().min(1) }).strict();

/**
 * §7.1 Groups & Permissions (admin). Groups are the SOLE permission-granting
 * mechanism (§3.8) — their union of capabilities is what members can do
 * system-wide, and space/branch group-permission grants hang off these rows.
 */
export async function groupRoutes(app: FastifyInstance) {
  app.get("/api/groups", { config: { access: "admin" } }, async (_request, reply) => {
    const { db } = getDb();
    const rows = await db
      .select({
        id: groups.id,
        name: groups.name,
        capabilities: groups.capabilities,
        createdAt: groups.createdAt,
        memberCount: sql<number>`(select count(*) from ${userGroups} where ${userGroups.groupId} = ${groups.id})`,
      })
      .from(groups);
    return reply.send(rows);
  });

  app.post("/api/groups", { config: { access: "admin" } }, async (request, reply) => {
    const body = createGroupBody.parse(request.body);
    const user = (request as any).userContext;
    const group = await createGroup(body.name, body.capabilities ?? []);
    const { db } = getDb();
    await db.insert(auditLog).values({
      actorUserId: user.id,
      action: "group_create",
      targetType: "group",
      targetId: group.id,
      meta: { name: group.name },
    });
    return reply.code(201).send(group);
  });

  app.patch("/api/groups/:id", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateGroupBody.parse(request.body);
    if (body.capabilities) await updateGroupCapabilities(id, body.capabilities);
    if (body.name) {
      const { db } = getDb();
      await db.update(groups).set({ name: body.name }).where(eq(groups.id, id));
    }
    const { db } = getDb();
    const [row] = await db.select().from(groups).where(eq(groups.id, id));
    if (!row) return reply.code(404).send({ error: "Group not found" });
    return reply.send(row);
  });

  app.delete("/api/groups/:id", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).userContext;
    const { db } = getDb();
    const [row] = await db.select().from(groups).where(eq(groups.id, id));
    if (!row) return reply.code(404).send({ error: "Group not found" });
    await deleteGroup(id);
    await db.insert(auditLog).values({
      actorUserId: user.id,
      action: "group_delete",
      targetType: "group",
      targetId: id,
      meta: { name: row.name },
    });
    return reply.code(204).send();
  });

  app.get("/api/groups/:id/members", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await listGroupMembers(id));
  });

  app.post("/api/groups/:id/members", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = addMemberBody.parse(request.body);
    const user = (request as any).userContext;
    await addGroupMember(id, body.userId);
    const { db } = getDb();
    await db.insert(auditLog).values({
      actorUserId: user.id,
      action: "group_member_add",
      targetType: "group",
      targetId: id,
      meta: { userId: body.userId },
    });
    return reply.code(201).send({ userId: body.userId });
  });

  app.delete("/api/groups/:id/members/:userId", { config: { access: "admin" } }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    await removeGroupMember(id, userId);
    return reply.code(204).send();
  });
}
