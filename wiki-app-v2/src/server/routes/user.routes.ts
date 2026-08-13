import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { auditLog, users } from "../db/schema.js";

const updateUserBody = z.object({
  isAdmin: z.boolean().optional(),
  suspended: z.boolean().optional(),
});

/**
 * §7.1 Users (admin). better-auth owns identity; this surface is the two
 * admin-only lifecycle fields folded onto the user row (isAdmin, suspended).
 * Both are `input:false` in the auth config, so the only path that can set
 * them is this route (or direct DB).
 */
export async function userRoutes(app: FastifyInstance) {
  app.get("/api/users", { config: { access: "admin" } }, async (_request, reply) => {
    const { db } = getDb();
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        isAdmin: users.isAdmin,
        suspended: users.suspended,
        createdAt: users.createdAt,
      })
      .from(users);
    return reply.send(rows);
  });

  app.patch("/api/users/:id", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateUserBody.parse(request.body);
    const actor = (request as any).userContext as { id: string; isAdmin: boolean };

    const { db } = getDb();
    const [row] = await db.select().from(users).where(eq(users.id, id));
    if (!row) return reply.code(404).send({ error: "User not found" });

    // Self-lockout guards: an admin must not be able to demote or suspend
    // themselves through the UI (recovering requires DB surgery otherwise).
    if (id === actor.id) {
      if (body.isAdmin === false) return reply.code(400).send({ error: "You cannot remove your own admin role" });
      if (body.suspended === true) return reply.code(400).send({ error: "You cannot suspend your own account" });
    }

    const set: { isAdmin?: boolean; suspended?: boolean } = {};
    if (body.isAdmin !== undefined) set.isAdmin = body.isAdmin;
    if (body.suspended !== undefined) set.suspended = body.suspended;
    if (Object.keys(set).length === 0) return reply.send(row);

    await db.update(users).set(set).where(eq(users.id, id));
    await db.insert(auditLog).values({
      actorUserId: actor.id,
      action: "user_update",
      targetType: "user",
      targetId: id,
      meta: { ...(set.isAdmin !== undefined ? { isAdmin: set.isAdmin } : {}), ...(set.suspended !== undefined ? { suspended: set.suspended } : {}) },
    });

    const [updated] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        isAdmin: users.isAdmin,
        suspended: users.suspended,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, id));
    return reply.send(updated);
  });
}
