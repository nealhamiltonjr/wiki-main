import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tokens } from "../db/schema.js";
import { createShareLink } from "../services/token.service.js";

const createShareBody = z.object({
  permission: z.enum(["view", "edit"]),
  expiresAt: z.string().datetime().nullable().optional(),
  password: z.string().max(200).optional(),
  name: z.string().max(120).optional(),
}).strict();

/**
 * Slice 24 — share links. Branch-scoped (so a share always resolves to the
 * exact placement the editor was looking at). The raw token is returned once;
 * the public URL is `?shareToken=<raw>` and is validated by the access
 * middleware.
 */
export async function shareRoutes(app: FastifyInstance) {
  app.get("/api/branches/:branchId/shares", { config: { access: { branchParam: "branchId", minRole: "editor" } } }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const user = (request as any).userContext as { id: string; isAdmin?: boolean };
    const { db } = getDb();
    const where = user.isAdmin
      ? and(eq(tokens.type, "share_link"), eq(tokens.scopeId, branchId), isNull(tokens.revokedAt))
      : and(eq(tokens.type, "share_link"), eq(tokens.scopeId, branchId), isNull(tokens.revokedAt), eq(tokens.createdBy, user.id));
    const rows = await db.select().from(tokens).where(where).all();
    return reply.send(rows.map((r) => ({
      id: r.id,
      name: r.name,
      permission: r.permission,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      lastAccessedAt: r.lastAccessedAt,
      warningCount: r.warningCount,
      passwordProtected: r.passwordHash !== null,
    })));
  });

  app.post("/api/branches/:branchId/shares", { config: { access: { branchParam: "branchId", minRole: "editor" } } }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const user = (request as any).userContext as { id: string; isAdmin?: boolean };
    const body = createShareBody.parse(request.body);
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    const { id, rawToken } = await createShareLink({
      branchOrSpaceId: branchId,
      scopeType: "branch",
      createdBy: user.id,
      isAdmin: !!user.isAdmin,
      permission: body.permission,
      expiresAt,
      password: body.password,
      name: body.name,
    });
    return reply.code(201).send({ id, token: rawToken, shareUrl: `/share/${branchId}?shareToken=${rawToken}` });
  });

  app.delete("/api/shares/:id", { config: { access: "authenticated" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).userContext as { id: string; isAdmin?: boolean };
    const { db } = getDb();
    const [row] = await db.select().from(tokens).where(eq(tokens.id, id));
    if (!row) return reply.code(404).send({ error: "Share link not found" });
    if (row.createdBy !== user.id && !user.isAdmin) return reply.code(403).send({ error: "Forbidden" });
    await db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.id, id));
    return reply.send({ ok: true });
  });
}
