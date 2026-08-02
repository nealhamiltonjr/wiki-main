import type { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { spaces, spaceMembers, spaceGroupPermissions, branches, pages } from "../db/schema.js";
import { buildSpaceTree, resolveSpaceRole } from "../services/branch.service.js";
import type { UserContext } from "../../shared/types.js";

const createSpaceBody = z.object({ name: z.string().min(1) });

export async function spaceRoutes(app: FastifyInstance) {
  app.post("/api/spaces", { config: { access: "authenticated" } }, async (request, reply) => {
    const body = createSpaceBody.parse(request.body);
    const user = (request as any).userContext;
    const spaceId = crypto.randomUUID();

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
}
