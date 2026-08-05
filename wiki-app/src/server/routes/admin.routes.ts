import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { systemLogs, users, pages, comments, sessions } from "../db/schema.js";

export async function adminRoutes(app: FastifyInstance) {
  // Fixed from the reviewed version (brief §3.18): this endpoint was completely
  // unauthenticated. It now requires global admin, enforced by the same
  // mandatory middleware as everything else.
  app.get("/api/admin/logs", { config: { access: "admin" } }, async (_request, reply) => {
    const rows = await db.select().from(systemLogs).orderBy(desc(systemLogs.createdAt)).limit(200);
    return reply.send(rows);
  });

  // ── User management ──────────────────────────────────────────────────────

  app.get("/api/admin/users", { config: { access: "admin" } }, async (_request, reply) => {
    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin, suspended: users.suspended })
      .from(users);
    return reply.send(rows);
  });

  app.post("/api/admin/users", { config: { access: "admin" } }, async (request, reply) => {
    const { email, name, password } = request.body as { email: string; name: string; password: string };
    if (!email || !name || !password) {
      return reply.code(400).send({ error: "email, name, and password are required" });
    }
    // Use better-auth's sign-up API to create the user through the proper auth flow.
    const { auth } = await import("../auth/config.js");
    try {
      const result = await auth.api.signUpEmail({
        body: { email, name, password },
        headers: request.headers as any,
      } as any);
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? "Failed to create user" });
    }
  });

  app.patch("/api/admin/users/:id/suspend", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.update(users).set({ suspended: true }).where(eq(users.id, id));
    // Kill all sessions for the suspended user.
    await db.delete(sessions).where(eq(sessions.userId, id));
    return reply.send({ ok: true });
  });

  app.patch("/api/admin/users/:id/unsuspend", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.update(users).set({ suspended: false }).where(eq(users.id, id));
    return reply.send({ ok: true });
  });

  app.delete("/api/admin/users/:id", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reassignToId } = request.body as { reassignToId?: string };

    if (reassignToId) {
      // Reassign pages and comments to another user before deleting.
      await db
        .update(pages)
        .set({ ownerId: reassignToId })
        .where(eq(pages.ownerId, id));
      await db
        .update(comments)
        .set({ userId: reassignToId })
        .where(eq(comments.userId, id));
    }

    // Delete sessions first (FK constraint in some setups).
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
    return reply.send({ ok: true });
  });
}
