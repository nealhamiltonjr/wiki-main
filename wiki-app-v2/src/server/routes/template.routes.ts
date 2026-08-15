import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { templates, pages } from "../db/schema.js";

const createTemplateBody = z.object({
  pageId: z.string().uuid(),
  name: z.string().min(1).max(120),
  scope: z.enum(["global", "user"]),
}).strict();

const updateTemplateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  scope: z.enum(["global", "user"]).optional(),
}).strict();

/**
 * Slice 26 — template CRUD. A template references an existing page (which
 * becomes the blueprint). `scope` is `user` (visible only to the creator) or
 * `global` (visible to everyone). Creating a `global` template requires admin.
 */
export async function templateRoutes(app: FastifyInstance) {
  app.get("/api/templates", { config: { access: "authenticated" } }, async (request, reply) => {
    const user = (request as any).userContext as { id: string; isAdmin?: boolean };
    const { db } = getDb();
    const rows = await db
      .select({
        id: templates.id,
        name: templates.name,
        scope: templates.scope,
        createdBy: templates.createdBy,
        pageId: templates.pageId,
        pageTitle: pages.title,
      })
      .from(templates)
      .innerJoin(pages, eq(templates.pageId, pages.id))
      .where(or(eq(templates.scope, "global"), and(eq(templates.scope, "user"), eq(templates.createdBy, user.id))));
    return reply.send(rows);
  });

  app.post("/api/templates", { config: { access: "authenticated" } }, async (request, reply) => {
    const user = (request as any).userContext as { id: string; isAdmin?: boolean };
    const body = createTemplateBody.parse(request.body);
    if (body.scope === "global" && !user.isAdmin) {
      return reply.code(403).send({ error: "Only admins can create global templates" });
    }
    const { db } = getDb();
    const [page] = await db.select({ id: pages.id }).from(pages).where(eq(pages.id, body.pageId));
    if (!page) return reply.code(404).send({ error: "Template page not found" });

    const id = crypto.randomUUID();
    await db.insert(templates).values({
      id,
      pageId: body.pageId,
      name: body.name,
      scope: body.scope,
      createdBy: user.id,
    });
    return reply.code(201).send({ id, ...body });
  });

  app.put("/api/templates/:id", { config: { access: "authenticated" } }, async (request, reply) => {
    const user = (request as any).userContext as { id: string; isAdmin?: boolean };
    const { id } = request.params as { id: string };
    const body = updateTemplateBody.parse(request.body);
    const { db } = getDb();
    const [row] = await db.select().from(templates).where(eq(templates.id, id));
    if (!row) return reply.code(404).send({ error: "Template not found" });
    if (row.createdBy !== user.id && !user.isAdmin) return reply.code(403).send({ error: "Forbidden" });
    if (body.scope === "global" && !user.isAdmin) return reply.code(403).send({ error: "Only admins can set global scope" });

    await db.update(templates).set({ name: body.name, scope: body.scope }).where(eq(templates.id, id));
    return reply.send({ ok: true });
  });

  app.delete("/api/templates/:id", { config: { access: "authenticated" } }, async (request, reply) => {
    const user = (request as any).userContext as { id: string; isAdmin?: boolean };
    const { id } = request.params as { id: string };
    const { db } = getDb();
    const [row] = await db.select().from(templates).where(eq(templates.id, id));
    if (!row) return reply.code(404).send({ error: "Template not found" });
    if (row.createdBy !== user.id && !user.isAdmin) return reply.code(403).send({ error: "Forbidden" });
    await db.delete(templates).where(eq(templates.id, id));
    return reply.send({ ok: true });
  });
}
