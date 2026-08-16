import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { attributes, pages, branches } from "../db/schema.js";
import { canViewPage, getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { UserContext } from "../../shared/types.js";
import { enqueueJob } from "../services/queue.service.js";

const createAttrBody = z.object({
  name: z.string().min(1).max(120),
  value: z.string().max(5000).optional(),
  valuePageId: z.string().uuid().nullable().optional(),
  isPromoted: z.boolean().optional(),
}).strict();

const updateAttrBody = z.object({
  name: z.string().min(1).max(120).optional(),
  value: z.string().max(5000).optional(),
  valuePageId: z.string().uuid().nullable().optional(),
  isPromoted: z.boolean().optional(),
}).strict();

/** True when the user can edit the page behind `pageId` via any placement. */
async function requireEditor(pageId: string, user: UserContext): Promise<boolean> {
  if (user.isAdmin) return true;
  const { db } = getDb();
  const [page] = await db.select({ id: pages.id }).from(pages).where(eq(pages.id, pageId));
  if (!page) return false;
  const placements = await db.select().from(branches).where(eq(branches.pageId, pageId));
  for (const b of placements) {
    const chain = await getBranchChain(b.id).catch(() => null);
    if (!chain) continue;
    const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
    const access = resolveAccess(user, chain, spaceRole);
    if (access === "editor" || access === "admin") return true;
  }
  return false;
}

/**
 * Slice 22 — page properties (attributes). Label/value pairs on a page;
 * `isPromoted` surfaces them in the editor sidebar. Read requires page read
 * access; mutation requires editor+ via any placement.
 */
export async function attributeRoutes(app: FastifyInstance) {
  app.get("/api/pages/:pageId/attributes", { config: { access: "authenticated" } }, async (request, reply) => {
    const { pageId } = request.params as { pageId: string };
    const user = (request as any).userContext as UserContext;
    if (!(await canViewPage(user, pageId))) return reply.code(404).send({ error: "Page not found" });
    const { db } = getDb();
    const rows = await db.select().from(attributes).where(eq(attributes.pageId, pageId));
    return reply.send(rows);
  });

  app.post("/api/pages/:pageId/attributes", { config: { access: "authenticated" } }, async (request, reply) => {
    const { pageId } = request.params as { pageId: string };
    const user = (request as any).userContext as UserContext;
    if (!(await requireEditor(pageId, user))) return reply.code(403).send({ error: "Forbidden" });
    const body = createAttrBody.parse(request.body);
    const { db } = getDb();
    const rows = await db.select({ p: attributes.position }).from(attributes).where(eq(attributes.pageId, pageId));
    const position = rows.reduce((max, r) => Math.max(max, r.p), -1) + 1;
    const value = body.valuePageId ? "" : (body.value ?? "");
    const id = crypto.randomUUID();
    await db.insert(attributes).values({
      id,
      pageId,
      name: body.name,
      value,
      valuePageId: body.valuePageId ?? null,
      isPromoted: body.isPromoted ?? false,
      position,
    });
    // Attribute changes are reflected in the next page-save git commit.
  // No separate git_commit job needed (it would fail with null branchId).
    return reply.code(201).send({ id, name: body.name, value, valuePageId: body.valuePageId ?? null, isPromoted: body.isPromoted ?? false, position });
  });

  app.put("/api/attributes/:id", { config: { access: "authenticated" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).userContext as UserContext;
    const { db } = getDb();
    const [row] = await db.select().from(attributes).where(eq(attributes.id, id));
    if (!row) return reply.code(404).send({ error: "Attribute not found" });
    if (!(await requireEditor(row.pageId, user))) return reply.code(403).send({ error: "Forbidden" });
    const body = updateAttrBody.parse(request.body);
    const set: Record<string, unknown> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.value !== undefined) set.value = body.value;
    if (body.valuePageId !== undefined) set.valuePageId = body.valuePageId;
    if (body.isPromoted !== undefined) set.isPromoted = body.isPromoted;
    await db.update(attributes).set(set).where(eq(attributes.id, id));
    await enqueueJob("git_commit", { pageId: row.pageId, branchId: null, kind: "attribute_change" });
    return reply.send({ ok: true });
  });

  app.delete("/api/attributes/:id", { config: { access: "authenticated" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).userContext as UserContext;
    const { db } = getDb();
    const [row] = await db.select().from(attributes).where(eq(attributes.id, id));
    if (!row) return reply.code(404).send({ error: "Attribute not found" });
    if (!(await requireEditor(row.pageId, user))) return reply.code(403).send({ error: "Forbidden" });
    await db.delete(attributes).where(eq(attributes.id, id));
    await enqueueJob("git_commit", { pageId: row.pageId, branchId: null, kind: "attribute_change" });
    return reply.send({ ok: true });
  });
}
