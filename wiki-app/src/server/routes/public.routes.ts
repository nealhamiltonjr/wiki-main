import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches, spaces as spacesTable } from "../db/schema.js";

/**
 * Public API routes — only active when PUBLIC_MODE environment variable is set. These
 * expose read-only access to content explicitly marked as public visibility, enabling
 * the wiki to serve as a public-facing documentation site without authentication.
 *
 * When PUBLIC_MODE is not set, these routes still register but return 404 for any
 * request, since the public surface is disabled.
 */

const publicMode = !!process.env.PUBLIC_MODE;

export async function publicRoutes(app: FastifyInstance) {
  // Config: tells the frontend whether public mode is active
  app.get("/api/public/config", { config: { access: "public" } }, async (_request, reply) => {
    return reply.send({ publicMode, siteName: process.env.PUBLIC_SITE_NAME || "Wiki" });
  });

  if (!publicMode) {
    // Register stub routes that return 404 when public mode is disabled
    app.get("/api/public/spaces", { config: { access: "public" } }, async (_request, reply) => {
      return reply.code(404).send({ error: "Public mode is not enabled" });
    });
    app.get("/api/public/spaces/:spaceId/pages", { config: { access: "public" } }, async (_request, reply) => {
      return reply.code(404).send({ error: "Public mode is not enabled" });
    });
    app.get("/api/public/pages/:branchId", { config: { access: "public" } }, async (_request, reply) => {
      return reply.code(404).send({ error: "Public mode is not enabled" });
    });
    return;
  }

  // List spaces with at least one public page
  app.get("/api/public/spaces", { config: { access: "public" } }, async (_request, reply) => {
    const rows = await db
      .selectDistinct({
        id: spacesTable.id,
        name: spacesTable.name,
      })
      .from(spacesTable)
      .innerJoin(branches, eq(branches.spaceId, spacesTable.id))
      .where(eq(branches.visibility, "public"));

    return reply.send(rows);
  });

  // List public pages within a space
  app.get(
    "/api/public/spaces/:spaceId/pages",
    { config: { access: "public" } },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };
      const rows = await db
        .select({
          branchId: branches.id,
          pageId: pages.id,
          slug: pages.slug,
          updatedAt: pages.updatedAt,
        })
        .from(branches)
        .innerJoin(pages, and(eq(pages.id, branches.pageId), isNull(pages.deletedAt)))
        .where(and(eq(branches.spaceId, spaceId), eq(branches.visibility, "public")));

      return reply.send(rows);
    }
  );

  // Get a public page by branch ID
  app.get(
    "/api/public/pages/:branchId",
    { config: { access: "public" } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };

      const row = await db
        .select({
          pageId: pages.id,
          slug: pages.slug,
          content: pages.content,
          updatedAt: pages.updatedAt,
          visibility: branches.visibility,
          spaceId: branches.spaceId,
        })
        .from(branches)
        .innerJoin(pages, eq(pages.id, branches.pageId))
        .where(eq(branches.id, branchId))
        .limit(1);

      const result = row[0];
      if (!result) return reply.code(404).send({ error: "Page not found" });
      if (result.visibility !== "public") {
        return reply.code(404).send({ error: "Page not found" });
      }

      return reply.send({
        pageId: result.pageId,
        slug: result.slug,
        content: result.content,
        updatedAt: result.updatedAt,
        spaceId: result.spaceId,
      });
    }
  );
}
