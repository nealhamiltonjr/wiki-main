import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { branches, files } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { storeFile, getFileForBranch, isInlineSafeMime } from "../services/file.service.js";
import { removeFileBlob } from "../services/git.service.js";
import { getSystemSetting } from "./settings.routes.js";

/**
 * Slice-44: admin-tunable per-route file upload cap. Default 25 MB
 * matches the pre-slice-44 behavior (which came from the multipart
 * fileSize ceiling in app.ts). We now enforce the cap inside this
 * route so the multipart ceiling in app.ts can be raised independently
 * to support larger plugin uploads. Clamp range 1 KB .. 500 MB.
 */
const FILE_UPLOAD_MIN = 1024;
const FILE_UPLOAD_MAX = 500 * 1024 * 1024;
const FILE_UPLOAD_DEFAULT = 25 * 1024 * 1024;

async function readFileUploadCap(): Promise<number> {
  const v = await getSystemSetting<unknown>("limits.fileUploadMaxBytes", FILE_UPLOAD_DEFAULT);
  if (typeof v !== "number" || !Number.isFinite(v) || v < FILE_UPLOAD_MIN || v > FILE_UPLOAD_MAX) {
    return FILE_UPLOAD_DEFAULT;
  }
  return Math.floor(v);
}

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

      // Slice-44: per-route file upload cap. Content-Length pre-check
      // before we ask @fastify/multipart to buffer the body into RAM,
      // then a final length check on the buffered payload in case the
      // client lied about Content-Length.
      const cap = await readFileUploadCap();
      const declaredLen = Number(request.headers["content-length"]);
      if (Number.isFinite(declaredLen) && declaredLen > cap) {
        return reply.code(413).send({ error: "File too large" });
      }

      const data = await mp.toBuffer();
      if (mp.file?.truncated) {
        return reply.code(413).send({ error: "File too large" });
      }
      if (data.length > cap) {
        return reply.code(413).send({ error: "File too large" });
      }
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

  // Delete a file. Editor-or-higher on the branch; removes the DB row and
  // schedules the blob removal from git. Content-addressable storage means the
  // blob is only actually removed when no other row references the same hash
  // (we keep the file on disk if any reference remains — the git rm commit is
  // only enqueued when the last reference goes away).
  app.delete(
    "/api/branches/:branchId/files/:fileId",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId, fileId } = request.params as { branchId: string; fileId: string };
      const { db } = getDb();
      const [file] = await db.select().from(files).where(eq(files.id, fileId));
      if (!file) return reply.code(404).send({ error: "File not found" });
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch || file.pageId !== branch.pageId) return reply.code(404).send({ error: "File not found" });

      await db.delete(files).where(eq(files.id, fileId));

      // Only drop the blob from git if no other file row shares this
      // content-addressed path (dedup semantics).
      const remaining = await db.select({ id: files.id }).from(files).where(eq(files.storagePath, file.storagePath));
      if (remaining.length === 0 && file.storagePath.startsWith("_files/")) {
        await removeFileBlob(file.storagePath);
      }

      return reply.send({ ok: true });
    }
  );
}
