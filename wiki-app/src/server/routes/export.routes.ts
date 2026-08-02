import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { spaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { exportPageBundle, exportSpaceBundle } from "../services/export.service.js";
import { buildZip } from "../services/zip.service.js";
import { resolveSpaceRole } from "../services/branch.service.js";
import type { UserContext, SpaceRole } from "../../shared/types.js";

function parseImages(q: unknown): "copy" | "strip" | "raw" {
  const v = String(Array.isArray(q) ? q[0] : q ?? "");
  return v === "copy" || v === "strip" ? v : "raw";
}
function parseFlag(q: unknown, fallback = false): boolean {
  const v = String(Array.isArray(q) ? q[0] : q ?? "");
  return v === "1" || v === "true" || (v === "" ? fallback : false);
}

export async function exportRoutes(app: FastifyInstance) {
  // §7.11 Single-page export. Branch access is checked by the middleware; the
  // page is served as clean Markdown (frontmatter optional, internal links
  // stripped). With images=copy the response is a zip containing the .md plus
  // the referenced blobs so the bundle is fully portable to any static site
  // generator.
  app.get(
    "/api/branches/:branchId/export",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const q = request.query as Record<string, unknown>;
      const images = parseImages(q.images);
      const frontmatter = parseFlag(q.frontmatter, true);

      const { markdownFile, assets } = await exportPageBundle(branchId, { images, frontmatter });
      const filename = markdownFile.path;

      if (images === "copy") {
        reply.header("Content-Type", "application/zip");
        reply.header("Content-Disposition", `attachment; filename="${filename.replace(/\.md$/, "")}.zip"`);
        return reply.send(buildZip([{ path: markdownFile.path, data: Buffer.from(markdownFile.content, "utf8") }, ...assets.map((a) => ({ path: a.path, data: a.data }))]));
      }

      reply.header("Content-Type", "text/markdown; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      return reply.send(markdownFile.content);
    }
  );

  // §7.11 Whole-space export as a zip: pages/*.md with SSG frontmatter plus
  // copied assets. The bundle contains exactly the pages the caller can read -
  // restricted sub-trees are skipped, so exporting a space can't leak pages the
  // exporter isn't allowed to see.
  app.get(
    "/api/spaces/:spaceId/export",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };
      const q = request.query as Record<string, unknown>;
      const frontmatter = parseFlag(q.frontmatter, true);
      const user = (request as any).userContext as UserContext;
      const spaceRole: SpaceRole | null = user.isAdmin
        ? "admin"
        : await resolveSpaceRole(user.id, spaceId, user.groupIds);

      const [space] = await db.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, spaceId));
      const { markdownFiles, assets } = await exportSpaceBundle(user, spaceId, spaceRole, { frontmatter });

      const entries = [
        ...markdownFiles.map((f) => ({ path: f.path, data: Buffer.from(f.content, "utf8") })),
        ...assets.map((a) => ({ path: a.path, data: a.data })),
      ];

      const zipName = `${(space?.name ?? "space").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}-export.zip`;
      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", `attachment; filename="${zipName}"`);
      return reply.send(buildZip(entries));
    }
  );
}
