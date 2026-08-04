import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listAttributes, createAttribute, updateAttribute, deleteAttribute, getAttributeById } from "../services/attribute.service.js";
import { db } from "../db/index.js";
import { branches } from "../db/schema.js";
import { eq } from "drizzle-orm";

const createBody = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(2000).default(""),
  isPromoted: z.boolean().optional(),
});

// branchId is required on update - it's what the permission middleware checks
// editor access against (see config.access below), and what the handler then
// cross-validates the attribute's own pageId against. Without it, editor
// access on ANY branch the caller happens to hold would be enough to edit an
// attribute belonging to a completely different, possibly-restricted page.
const updateBody = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  value: z.string().max(2000).optional(),
  isPromoted: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

const deleteQuery = z.object({
  branchId: z.string().min(1),
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

  // Update attribute (editor+ on the branchId supplied in the body)
  app.put(
    "/api/attributes/:id",
    { config: { access: { branchParam: "branchId", minRole: "editor", source: "body" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateBody.parse(request.body);

      const existing = await getAttributeById(id);
      if (!existing) return reply.code(404).send({ error: "Attribute not found" });

      // The middleware confirmed editor access on body.branchId - now confirm
      // that branch actually belongs to the same page this attribute is on.
      const ownerPageId = pageIdFromBranch(body.branchId);
      if (!ownerPageId || ownerPageId !== existing.pageId) {
        return reply.code(403).send({ error: "branchId does not own this attribute" });
      }

      const { branchId: _branchId, ...fields } = body;
      const attr = await updateAttribute(id, fields);
      if (!attr) return reply.code(404).send({ error: "Attribute not found" });
      return reply.send(attr);
    }
  );

  // Delete attribute (editor+ on the branchId supplied as a query param -
  // DELETE requests carry no request body in this app's client, see §7.4)
  app.delete(
    "/api/attributes/:id",
    { config: { access: { branchParam: "branchId", minRole: "editor", source: "query" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { branchId } = deleteQuery.parse(request.query);

      const existing = await getAttributeById(id);
      if (!existing) return reply.code(404).send({ error: "Attribute not found" });

      const ownerPageId = pageIdFromBranch(branchId);
      if (!ownerPageId || ownerPageId !== existing.pageId) {
        return reply.code(403).send({ error: "branchId does not own this attribute" });
      }

      const ok = await deleteAttribute(id);
      if (!ok) return reply.code(404).send({ error: "Attribute not found" });
      return reply.send({ ok: true });
    }
  );
}
