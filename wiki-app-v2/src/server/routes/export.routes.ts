import type { FastifyInstance } from "fastify";
import { exportBranch, exportSpace, buildZip } from "../services/export.service.js";
import type { UserContext } from "../../shared/types.js";

export async function exportRoutes(app: FastifyInstance) {
  app.get("/api/branches/:branchId/export", { config: { access: { branchParam: "branchId", minRole: "viewer" } } }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const query = request.query as { format?: string };
    const format = query.format ?? "zip";
    try {
      const { files, assets } = await exportBranch(branchId, { includeImages: true });
      if (format === "markdown") { const md = files[0]?.content ?? ""; reply.header("Content-Type", "text/markdown; charset=utf-8"); reply.header("Content-Disposition", `attachment; filename="${files[0]?.path?.split("/").pop() ?? "page.md"}"`); return reply.send(md); }
      const zip = buildZip(files, assets);
      reply.header("Content-Type", "application/zip"); reply.header("Content-Disposition", `attachment; filename="page-${branchId.slice(0, 8)}.zip"`);
      return reply.send(Buffer.from(zip));
    } catch (err) { return reply.code(500).send({ error: (err as Error).message }); }
  });

  app.get("/api/spaces/:spaceId/export", { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } }, async (request, reply) => {
    const { spaceId } = request.params as { spaceId: string };
    const user = (request as any).userContext as UserContext;
    try {
      const { files, assets } = await exportSpace(spaceId, user, { includeImages: true });
      if (files.length === 0) return reply.code(404).send({ error: "No exportable pages" });
      const zip = buildZip(files, assets);
      reply.header("Content-Type", "application/zip"); reply.header("Content-Disposition", `attachment; filename="space-export.zip"`);
      return reply.send(Buffer.from(zip));
    } catch (err) { return reply.code(500).send({ error: (err as Error).message }); }
  });
}
