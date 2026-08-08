import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { spaces, spaceMembers, spaceGroupPermissions, users, groups } from "../db/schema.js";
import { listGroups } from "../services/group.service.js";
import { buildSpaceTree, resolveSpaceRole } from "../services/branch.service.js";
import type { UserContext } from "../../shared/types.js";

const createSpaceBody = z.object({ name: z.string().min(1) });

export async function spaceRoutes(app: FastifyInstance) {
  app.post("/api/spaces", { config: { access: "authenticated" } }, async (request, reply) => {
    const body = createSpaceBody.parse(request.body);
    const user = (request as any).userContext;
    const spaceId = crypto.randomUUID();

    const { db } = getDb();
    db.transaction((tx) => {
      tx.insert(spaces).values({ id: spaceId, name: body.name, createdBy: user.id }).run();
      tx.insert(spaceMembers).values({ spaceId, userId: user.id, role: "admin" }).run();
    });

    return reply.code(201).send({ id: spaceId, name: body.name });
  });

  // Lists every space the user has some role in (direct membership or via a
  // group), plus all spaces if they're admin. Not branch-scoped, so this uses
  // "authenticated" and filters inside the handler rather than the declarative
  // per-route check - there's no single branch to key a check off here.
  app.get("/api/spaces", { config: { access: "authenticated" } }, async (request, reply) => {
    const { db } = getDb();
    const user = (request as any).userContext;
    if (user.isAdmin) {
      const all = await db.select().from(spaces);
      return reply.send(all);
    }

    const direct = await db.select({ space: spaces }).from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.userId, user.id));

    let viaGroups: { space: typeof spaces.$inferSelect }[] = [];
    if (user.groupIds.length > 0) {
      viaGroups = await db.select({ space: spaces }).from(spaceGroupPermissions)
        .innerJoin(spaces, eq(spaces.id, spaceGroupPermissions.spaceId))
        .where(sql`${spaceGroupPermissions.groupId} IN ${user.groupIds}`);
    }

    const byId = new Map([...direct, ...viaGroups].map((r) => [r.space.id, r.space]));
    return reply.send([...byId.values()]);
  });

  // Per-space tree listing. Access is space-scoped; per-node permission pruning
  // (restricted-ancestor integration, §7.12g) is shared with the branch-scoped
  // tree endpoint via buildSpaceTree so the two can never drift.
  app.get(
    "/api/spaces/:spaceId/tree",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };
      const user = (request as any).userContext as UserContext;
      const spaceRole = user.isAdmin ? "admin" as const : await resolveSpaceRole(user.id, spaceId, user.groupIds);
      const tokenScope = (request as any).tokenScope as { scopeType: string; scopeId: string } | undefined;
      const branchTokenScopeId =
        (request as any).principalKind === "token" && tokenScope?.scopeType === "branch" ? tokenScope.scopeId : null;

      return reply.send(await buildSpaceTree(spaceId, { user, spaceRole, branchTokenScopeId }));
    }
  );

  // -----------------------------------------------------------------------
  // Space permission management — space admin only (or global admin).
  // -----------------------------------------------------------------------

  const spaceAdminGuard = async (request: any, reply: any) => {
    const { spaceId } = request.params as { spaceId: string };
    const user = request.userContext as UserContext;
    if (user.isAdmin) return null;
    const role = await resolveSpaceRole(user.id, spaceId, user.groupIds);
    if (role !== "admin") return reply.code(403).send({ error: "Space admin access required" });
    return null;
  };

  app.get(
    "/api/spaces/:spaceId/permissions",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await spaceAdminGuard(request, reply);
      if (blocked) return blocked;
      const { spaceId } = request.params as { spaceId: string };

      const { db } = getDb();
      const [space] = await db.select({ defaultRole: spaces.defaultRole }).from(spaces).where(eq(spaces.id, spaceId));
      const members = await db
        .select({
          userId: spaceMembers.userId,
          role: spaceMembers.role,
          email: users.email,
          name: users.name,
        })
        .from(spaceMembers)
        .innerJoin(users, eq(users.id, spaceMembers.userId))
        .where(eq(spaceMembers.spaceId, spaceId));

      const groupGrants = await db
        .select({
          id: spaceGroupPermissions.id,
          groupId: spaceGroupPermissions.groupId,
          role: spaceGroupPermissions.role,
          groupName: groups.name,
        })
        .from(spaceGroupPermissions)
        .innerJoin(groups, eq(groups.id, spaceGroupPermissions.groupId))
        .where(eq(spaceGroupPermissions.spaceId, spaceId));

      // Available groups (name list only, same pattern as the branch dialog -
      // not sensitive) so space admins can add grants without global admin.
      const allGroups = await listGroups();

      return reply.send({ defaultRole: space?.defaultRole ?? "editor", members, groupGrants, groups: allGroups });
    }
  );

  app.post(
    "/api/spaces/:spaceId/members",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await spaceAdminGuard(request, reply);
      if (blocked) return blocked;
      const { spaceId } = request.params as { spaceId: string };
      const body = z.object({ userId: z.string().min(1), role: z.enum(["viewer", "editor", "admin"]) }).parse(request.body);

      const { db } = getDb();
      await db.insert(spaceMembers).values({ spaceId, userId: body.userId, role: body.role }).onConflictDoUpdate({
        target: [spaceMembers.spaceId, spaceMembers.userId],
        set: { role: body.role },
      });
      return reply.code(201).send({ ok: true });
    }
  );

  app.delete(
    "/api/spaces/:spaceId/members/:userId",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await spaceAdminGuard(request, reply);
      if (blocked) return blocked;
      const { spaceId, userId } = request.params as { spaceId: string; userId: string };

      const { db } = getDb();
      await db.delete(spaceMembers).where(
        and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId))
      );
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/api/spaces/:spaceId/group-grants",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await spaceAdminGuard(request, reply);
      if (blocked) return blocked;
      const { spaceId } = request.params as { spaceId: string };
      const body = z.object({ groupId: z.string().min(1), role: z.enum(["viewer", "editor", "admin"]) }).parse(request.body);

      const { db } = getDb();
      await db.insert(spaceGroupPermissions).values({
        id: crypto.randomUUID(),
        spaceId,
        groupId: body.groupId,
        role: body.role,
      });
      return reply.code(201).send({ ok: true });
    }
  );

  app.delete(
    "/api/spaces/:spaceId/group-grants/:grantId",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await spaceAdminGuard(request, reply);
      if (blocked) return blocked;
      const { spaceId, grantId } = request.params as { spaceId: string; grantId: string };

      const { db } = getDb();
      await db.delete(spaceGroupPermissions).where(
        and(eq(spaceGroupPermissions.id, grantId), eq(spaceGroupPermissions.spaceId, spaceId))
      );
      return reply.send({ ok: true });
    }
  );

  app.put(
    "/api/spaces/:spaceId/default-role",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await spaceAdminGuard(request, reply);
      if (blocked) return blocked;
      const { spaceId } = request.params as { spaceId: string };
      const body = z.object({ defaultRole: z.enum(["editor", "viewer", "none"]) }).parse(request.body);

      const { db } = getDb();
      await db.update(spaces).set({ defaultRole: body.defaultRole }).where(eq(spaces.id, spaceId));
      return reply.send({ ok: true });
    }
  );
}
