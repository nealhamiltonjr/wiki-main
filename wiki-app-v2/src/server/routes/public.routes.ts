import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pages, branches, spaces as spacesTable } from "../db/schema.js";

/**
 * Public mode routes (Phase 4 fix — Claude audit finding #1).
 *
 * Unauthenticated visitors can browse pages whose branch `visibility` is set
 * to `"public"`. This restores V14's public-facing documentation capability.
 *
 * All routes are `access: "public"` — the middleware skips auth entirely.
 * The routes themselves filter to only `visibility = "public"` branches, so
 * private content never leaks.
 */

export async function publicRoutes(app: FastifyInstance) {
  // List spaces that have at least one public branch.
  app.get("/api/public/spaces", { config: { access: "public" } }, async (_request, reply) => {
    const { sqlite } = getDb();
    const rows = sqlite
      .prepare(
        `SELECT DISTINCT s.id, s.name
         FROM spaces s
         JOIN branches b ON b.space_id = s.id
         WHERE b.visibility = 'public'
         ORDER BY s.name`,
      )
      .all() as { id: string; name: string }[];
    return reply.send(rows);
  });

  // List public pages in a space (flat list — the tree structure isn't needed
  // for the public viewer, which is a simple list of readable pages).
  app.get("/api/public/spaces/:spaceId/pages", { config: { access: "public" } }, async (request, reply) => {
    const { spaceId } = request.params as { spaceId: string };
    const { sqlite } = getDb();
    const rows = sqlite
      .prepare(
        `SELECT b.id as branchId, p.id as pageId, p.slug, p.title
         FROM branches b
         JOIN pages p ON p.id = b.page_id
         WHERE b.space_id = ? AND b.visibility = 'public' AND p.deleted_at IS NULL
         ORDER BY p.title`,
      )
      .all(spaceId) as { branchId: string; pageId: string; slug: string; title: string }[];
    return reply.send(rows);
  });

  // Get a single public page's content.
  app.get("/api/public/pages/:branchId", { config: { access: "public" } }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const { db, sqlite } = getDb();

    // Walk the branch chain to find the resolved visibility (nearest-first,
    // first non-"inherit" wins — same logic as the permission algorithm).
    const branchRows = sqlite
      .prepare(
        `WITH RECURSIVE chain AS (
          SELECT id, page_id, parent_branch_id, space_id, visibility FROM branches WHERE id = ?
          UNION ALL
          SELECT b.id, b.page_id, b.parent_branch_id, b.space_id, b.visibility
          FROM branches b JOIN chain ON b.id = chain.parent_branch_id
        )
        SELECT id, visibility FROM chain`,
      )
      .all(branchId) as { id: string; visibility: string }[];

    let resolvedVisibility = "inherit";
    for (const b of branchRows) {
      if (b.visibility !== "inherit") {
        resolvedVisibility = b.visibility;
        break;
      }
    }
    if (resolvedVisibility !== "public") {
      return reply.code(404).send({ error: "Page not found" });
    }

    const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
    if (!branch) return reply.code(404).send({ error: "Page not found" });
    const [page] = await db.select().from(pages).where(and(eq(pages.id, branch.pageId), isNull(pages.deletedAt)));
    if (!page) return reply.code(404).send({ error: "Page not found" });
    if (page.isEncrypted) return reply.code(404).send({ error: "Page not found" });

    const [space] = await db.select().from(spacesTable).where(eq(spacesTable.id, branch.spaceId));

    return reply.send({
      pageId: page.id,
      branchId: branch.id,
      slug: page.slug,
      title: page.title,
      content: page.content,
      pageType: page.pageType,
      language: page.language,
      spaceId: branch.spaceId,
      spaceName: space?.name ?? "",
      updatedAt: page.updatedAt?.toISOString(),
    });
  });
}
