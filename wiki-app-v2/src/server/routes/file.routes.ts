import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { branches } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { storeFile, getFileForBranch, isInlineSafeMime } from "../services/file.service.js";

/**
 * File upload + serving (brief §3.2 file-hardening, §3.13a branch-context).
 * Uploads are editor-scoped on the branch; downloads are viewer-scoped (or
 * share-token) on the branch. Files outside the inline-safe MIME allowlist
 * (raster images only — NOT SVG) are forced to download via
 * Content-Disposition: attachment, and nosniff is set on every file response
 * (also applied globally by security.ts).
 */
export async function fileRoutes(app: FastifyInstance) {
  app.post(
    "/api/branches/:branchId/files",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const user = (request as any).userContext;

      const mp = await request.file();
      if (!mp) return reply.code(400).send({ error: "No file provided" });

      const { db } = getDb();
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) return reply.code(404).send({ error: "Branch not found" });

      const data = await mp.toBuffer();
      const id = await storeFile({
        pageId: branch.pageId,
        filename: mp.filename,
        mimeType: mp.mimetype,
        data,
        uploadedBy: user.id,
      });

      return reply.code(201).send({ id, filename: mp.filename });
    }
  );

  // The URL includes the branch id deliberately (§3.13a) — permission is
  // checked against THIS branch, not against the file or its page in isolation.
  // `allowShareToken` lets anonymous viewers of a shared page load its embedded
  // images: the share route rewrites image srcs to carry `?shareToken=...`, and
  // the middleware resolves that token against this branch before serving.
  app.get(
    "/api/branches/:branchId/files/:fileId",
    { config: { access: { branchParam: "branchId", minRole: "viewer", allowShareToken: true } } },
    async (request, reply) => {
      const { branchId, fileId } = request.params as { branchId: string; fileId: string };
      const result = await getFileForBranch(fileId, branchId);
      if (!result) return reply.code(404).send({ error: "File not found" });

      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Type", result.file.mimeType);
      // §3.2: anything outside the inline-safe allowlist is forced to download.
      if (!isInlineSafeMime(result.file.mimeType)) {
        const safeName = result.file.filename.replace(/["\\\r\n]/g, "_");
        reply.header("Content-Disposition", `attachment; filename="${safeName}"`);
      }
      return reply.send(result.data);
    }
  );
}
