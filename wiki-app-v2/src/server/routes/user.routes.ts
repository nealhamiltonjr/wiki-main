import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { auditLog, users } from "../db/schema.js";
import { reassignUserContent, deleteUserContent } from "../services/user-delete.service.js";

const updateUserBody = z.object({
  isAdmin: z.boolean().optional(),
  suspended: z.boolean().optional(),
}).strict();

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

    const { db, sqlite } = getDb();
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

    // Slice-43: lockout guard for concurrent admin demote races. The
    // invariant we MUST preserve: at least one active admin must remain
    // after the patch commits. self-lockout (above) prevents the solo-
    // admin self-demote case. But two concurrent PATCHes — A demoting
    // B and B demoting A — both pass self-lockout (different targets)
    // and each UPDATE alone would leave at least one admin remaining.
    // Run them in parallel with no guard and the second writer commits
    // *after* the first's demote has already landed, so by the time the
    // second's commit fires, the active-admin count has just dropped to
    // one (the second writer's actor). Removing that one too leaves zero.
    //
    // The guard re-checks the total count inside a transaction so the
    // second writer's re-read sees the first writer's committed state.
    // If at commit time there is exactly one active admin (the second
    // writer, surviving the first writer's demote), and this patch would
    // demote that lone admin, abort with 409 before touching the row.
    //
    // Important details:
    //   - The query is the TOTAL active-admin count, not "excluding
    //     target" or "excluding actor". Subtracting target from the
    //     count reads like the obvious check but breaks the race: A
    //     excludes B and sees 1 (itself, surviving), proceeds; B
    //     excludes A and sees 1 (itself, surviving), proceeds — both
    //     commit and zero admins remain. The right check is "would
    //     my commit leave zero?", and "1 active admin" is the only
    //     pre-commit state from which any successful demote produces
    //     zero.
    //   - The transaction must be `immediate: true` (BEGIN IMMEDIATE,
    //     not better-sqlite3's default BEGIN DEFERRED). A deferred
    //     BEGIN doesn't acquire the write lock until the first write
    //     statement; our guard body is read-only, so a deferred
    //     transaction holds no lock at all and both writers' counts
    //     see the pre-race state. IMMEDIATE acquires the lock at
    //     BEGIN; the second writer blocks until the first commits,
    //     then re-counts against the post-commit state.
    const targetIsCurrentlyAdmin = row.isAdmin === true;
    const targetIsCurrentlyActive = row.suspended !== true;
    // Only enter the lockout guard when this patch will *reduce* the
    // active-admin count. A patch that demotes a suspended admin (no
    // effect on active count) or sets suspended=true on a suspended user
    // (already inactive) is harmless to the invariant — the guard would
    // only generate false-positive 409s in those cases.
    const willRemoveActiveAdmin =
      (set.isAdmin === false && targetIsCurrentlyAdmin && targetIsCurrentlyActive) ||
      (set.suspended === true && targetIsCurrentlyAdmin && targetIsCurrentlyActive);

    if (willRemoveActiveAdmin) {
      try {
        sqlite.transaction(() => {
          const result = sqlite
            .prepare(
              "SELECT COUNT(*) AS n FROM user WHERE is_admin = 1 AND suspended = 0",
            )
            .all() as { n: number }[];
          const n = result[0]?.n ?? 0;
          if (n === 1) {
            throw new LastAdminError();
          }
        }).immediate();
      } catch (err) {
        if (err instanceof LastAdminError) {
          return reply.code(409).send({
            error: "cannot demote or suspend the last active admin",
          });
        }
        throw err;
      }
    }

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

  // Phase 2.5 — Mentionable users
  app.get("/api/users/mentionable", { config: { access: "authenticated" } }, async (request, reply) => {
    const me = (request as any).userContext as { id: string };
    const { sqlite } = getDb();
    const spaceRows = sqlite.prepare("SELECT DISTINCT space_id FROM space_members WHERE user_id = ?").all(me.id) as { space_id: string }[];
    if (spaceRows.length === 0) return reply.send([]);
    const spaceIds = spaceRows.map((r) => r.space_id);
    const placeholders = spaceIds.map(() => "?").join(",");
    const rows = sqlite.prepare(`SELECT DISTINCT u.id, u.name, u.email FROM "user" u JOIN space_members sm ON sm.user_id = u.id WHERE sm.space_id IN (${placeholders}) AND u.id != ? AND u.suspended = 0 ORDER BY u.name LIMIT 100`).all(...spaceIds, me.id) as { id: string; name: string; email: string }[];
    return reply.send(rows);
  });

  // Phase 3.6 — Admin user deletion with content reassignment
  app.delete("/api/users/:id", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { mode?: string; targetUserId?: string; fallbackUserId?: string };
    const actor = (request as any).userContext as { id: string };
    if (id === actor.id) return reply.code(409).send({ error: "Cannot delete your own account" });
    const { db, sqlite } = getDb();
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) return reply.code(404).send({ error: "User not found" });
    const adminCount = sqlite.prepare("SELECT COUNT(*) as n FROM user WHERE is_admin = 1 AND suspended = 0").get() as { n: number };
    if (target.isAdmin && adminCount.n <= 1) return reply.code(409).send({ error: "Cannot delete the last admin" });
    const mode = query.mode ?? "reassign";
    try {
      if (mode === "reassign") {
        if (!query.targetUserId) return reply.code(400).send({ error: "targetUserId required" });
        const [t2] = await db.select().from(users).where(eq(users.id, query.targetUserId));
        if (!t2) return reply.code(404).send({ error: "Target user not found" });
        await reassignUserContent(id, query.targetUserId);
      } else if (mode === "delete") {
        if (!query.fallbackUserId) return reply.code(400).send({ error: "fallbackUserId required" });
        const [fb] = await db.select().from(users).where(eq(users.id, query.fallbackUserId));
        if (!fb) return reply.code(404).send({ error: "Fallback user not found" });
        await deleteUserContent(id, query.fallbackUserId);
      } else { return reply.code(400).send({ error: `Unknown mode: ${mode}` }); }
      await db.insert(auditLog).values({ actorUserId: actor.id, action: "user_delete", targetType: "user", targetId: id, meta: { mode, targetUserId: query.targetUserId, fallbackUserId: query.fallbackUserId } });
      await db.delete(users).where(eq(users.id, id));
      return reply.send({ ok: true });
    } catch (err) { return reply.code(500).send({ error: (err as Error).message }); }
  });
}

/**
 * Sentinel thrown inside the last-admin transaction. Distinct class so the
 * route can map it cleanly to a 409 while letting any unexpected SQLite
 * error propagate.
 */
class LastAdminError extends Error {
  constructor() {
    super("last admin");
    this.name = "LastAdminError";
  }
}
