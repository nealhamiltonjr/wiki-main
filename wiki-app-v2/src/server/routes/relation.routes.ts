import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { pages } from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  addRelation,
  canEditPage,
  canReadPage,
  listIncomingRelations,
  listOwnedRelations,
  RelationValidationError,
  removeRelation,
} from "../services/relation.service.js";
import type { UserContext } from "../../shared/types.js";

const createSchema = z.object({
  type: z.string().min(1).max(64),
  toPageId: z.string().min(1),
  position: z.number().int().optional(),
});

function caller(request: unknown): UserContext | null {
  const r = request as { userContext?: UserContext };
  return r.userContext ?? null;
}

export async function relationRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // List relations declared by this page (owned / outgoing).
  // -------------------------------------------------------------------------
  app.get<{ Params: { pageId: string } }>(
    "/api/pages/:pageId/relations",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      if (!(await canReadPage(request.params.pageId, u))) {
        return reply.code(404).send({ error: "page not found" });
      }
      const owned = await listOwnedRelations(request.params.pageId, u);
      return reply.send({ owned });
    },
  );

  // -------------------------------------------------------------------------
  // List relations pointing AT this page (incoming).
  // -------------------------------------------------------------------------
  app.get<{ Params: { pageId: string } }>(
    "/api/pages/:pageId/relations/incoming",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      if (!(await canReadPage(request.params.pageId, u))) {
        return reply.code(404).send({ error: "page not found" });
      }
      const incoming = await listIncomingRelations(request.params.pageId, u);
      return reply.send({ incoming });
    },
  );

  // -------------------------------------------------------------------------
  // Create a relation.
  // -------------------------------------------------------------------------
  app.post<{ Params: { pageId: string } }>(
    "/api/pages/:pageId/relations",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      if (!(await canEditPage(request.params.pageId, u))) {
        return reply.code(403).send({ error: "no edit access to source page" });
      }
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      try {
        const rel = await addRelation(
          {
            fromPageId: request.params.pageId,
            type: parsed.data.type,
            toPageId: parsed.data.toPageId,
            position: parsed.data.position,
          },
          u,
        );
        return reply.code(201).send(rel);
      } catch (err) {
        if (err instanceof RelationValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Delete a relation.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { pageId: string; attributeId: string } }>(
    "/api/pages/:pageId/relations/:attributeId",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      // Path `pageId` must match the actual source page of the relation
      // (prevents a caller with edit rights on pageA from deleting
      // pageA-stored relations by guessing attribute IDs on pageB).
      const { db } = getDb();
      const [row] = await db
        .select({ pageId: pages.id })
        .from(pages)
        .where(eq(pages.id, request.params.pageId))
        .limit(1);
      if (!row) return reply.code(404).send({ error: "page not found" });
      if (!(await canEditPage(request.params.pageId, u))) {
        return reply.code(403).send({ error: "no edit access to source page" });
      }
      try {
        await removeRelation(request.params.attributeId, u);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof RelationValidationError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  void z;
}
