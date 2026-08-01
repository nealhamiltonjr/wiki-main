import type { FastifyInstance } from "fastify";
import { desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { systemLogs, users } from "../db/schema.js";

export async function adminRoutes(app: FastifyInstance) {
  // Fixed from the reviewed version (brief §3.18): this endpoint was completely
  // unauthenticated. It now requires global admin, enforced by the same
  // mandatory middleware as everything else.
  app.get("/api/admin/logs", { config: { access: "admin" } }, async (_request, reply) => {
    const rows = await db.select().from(systemLogs).orderBy(desc(systemLogs.createdAt)).limit(200);
    return reply.send(rows);
  });

  app.get("/api/admin/users", { config: { access: "admin" } }, async (_request, reply) => {
    const rows = await db.select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin }).from(users);
    return reply.send(rows);
  });
}
