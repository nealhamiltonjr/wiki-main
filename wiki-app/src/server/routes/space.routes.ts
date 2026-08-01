import type { FastifyInstance } from "fastify";
import { eq, and, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { spaces, spaceMembers, spaceGroupPermissions, branches, pages } from "../db/schema.js";

interface TreeNode {
  id: string;
  pageId: string;
  slug: string;
  children: TreeNode[];
}

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

  app.get(
    "/api/spaces/:spaceId/tree",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };

      const rows = await db
        .select({ branchId: branches.id, pageId: branches.pageId, parentId: branches.parentBranchId, slug: pages.slug })
        .from(branches)
        .innerJoin(pages, eq(branches.pageId, pages.id))
        .where(and(eq(branches.spaceId, spaceId), eq(branches.isSystem, false), isNull(pages.deletedAt)));

      const map = new Map<string, TreeNode>();
      const roots: TreeNode[] = [];
      for (const r of rows) map.set(r.branchId, { id: r.branchId, pageId: r.pageId, slug: r.slug, children: [] });
      for (const r of rows) {
        const node = map.get(r.branchId)!;
        if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(node);
        else roots.push(node);
      }
      return reply.send(roots);
    }
  );
}
