import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { branches } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { storeFile, getFileForBranch } from "../services/file.service.js";

export async function fileRoutes(app: FastifyInstance) {
  app.post(
    "/api/branches/:branchId/files",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const user = (request as any).userContext;

      const mp = await request.file();
      if (!mp) return reply.code(400).send({ error: "No file provided" });

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

  // The URL includes the branch id deliberately (§3.13a) - permission is
  // checked against THIS branch, not against the file or its page in isolation.
  app.get(
    "/api/branches/:branchId/files/:fileId",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { branchId, fileId } = request.params as { branchId: string; fileId: string };
      const result = await getFileForBranch(fileId, branchId);
      if (!result) return reply.code(404).send({ error: "File not found" });

      reply.header("Content-Type", result.file.mimeType);
      return reply.send(result.data);
    }
  );
}
