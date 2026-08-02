import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listAttributes, createAttribute, updateAttribute, deleteAttribute } from "../services/attribute.service.js";
import { db } from "../db/index.js";
import { branches } from "../db/schema.js";
import { eq } from "drizzle-orm";

const createBody = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(2000).default(""),
  isPromoted: z.boolean().optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  value: z.string().max(2000).optional(),
  isPromoted: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

/** Resolve pageId from branchId so we can use branch-level access control. */
function pageIdFromBranch(branchId: string): string | null {
  const b = db.select({ pageId: branches.pageId }).from(branches).where(eq(branches.id, branchId)).get() as { pageId: string } | undefined;
  return b?.pageId ?? null;
}

export async function attributeRoutes(app: FastifyInstance) {
  // List attributes for a page (any reader can view)
  app.get(
    "/api/branches/:branchId/attributes",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const pageId = pageIdFromBranch(branchId);
      if (!pageId) return reply.code(404).send({ error: "Branch not found" });
      return reply.send({ attributes: await listAttributes(pageId) });
    }
  );

  // Create attribute (editor+)
  app.post(
    "/api/branches/:branchId/attributes",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const pageId = pageIdFromBranch(branchId);
      if (!pageId) return reply.code(404).send({ error: "Branch not found" });
      const body = createBody.parse(request.body);
      const attr = await createAttribute(pageId, body.name, body.value, body.isPromoted);
      return reply.code(201).send(attr);
    }
  );

  // Update attribute
  app.put(
    "/api/attributes/:id",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateBody.parse(request.body);
      const attr = await updateAttribute(id, body);
      if (!attr) return reply.code(404).send({ error: "Attribute not found" });
      return reply.send(attr);
    }
  );

  // Delete attribute
  app.delete(
    "/api/attributes/:id",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = await deleteAttribute(id);
      if (!ok) return reply.code(404).send({ error: "Attribute not found" });
      return reply.send({ ok: true });
    }
  );
}
