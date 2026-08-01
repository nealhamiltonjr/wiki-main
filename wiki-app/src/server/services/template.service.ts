import { eq, or, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { templates, pages } from "../db/schema.js";

export async function createTemplate(opts: { pageId: string; name: string; scope: "global" | "user"; createdBy: string }) {
  const id = crypto.randomUUID();
  await db.insert(templates).values({
    id,
    pageId: opts.pageId,
    name: opts.name,
    scope: opts.scope,
    createdBy: opts.createdBy,
  });
  return { id };
}

/** Global templates are visible to everyone; user templates only to their creator. */
export async function listTemplatesForUser(userId: string) {
  return db
    .select({ id: templates.id, name: templates.name, scope: templates.scope, pageId: templates.pageId })
    .from(templates)
    .where(or(eq(templates.scope, "global"), and(eq(templates.scope, "user"), eq(templates.createdBy, userId))));
}

export async function deleteTemplate(id: string, userId: string, isAdmin: boolean) {
  const [tpl] = await db.select().from(templates).where(eq(templates.id, id));
  if (!tpl) return { ok: false as const, reason: "not_found" as const };
  if (!isAdmin && tpl.createdBy !== userId) return { ok: false as const, reason: "forbidden" as const };
  await db.delete(templates).where(eq(templates.id, id));
  return { ok: true as const };
}

/** The actual content to seed a new page with, copied from the template's source page. */
export async function getTemplateContent(id: string) {
  const [tpl] = await db.select().from(templates).where(eq(templates.id, id));
  if (!tpl) return null;
  const [page] = await db.select().from(pages).where(eq(pages.id, tpl.pageId));
  return page?.content ?? null;
}
