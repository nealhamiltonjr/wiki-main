import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { systemLogs, users, pages, sessions, branches } from "../db/schema.js";
import { exportMarkdown } from "../services/markdown.service.js";
import { buildZip } from "../services/zip.service.js";
import { reassignUserContent, deleteUserContent } from "../services/user-delete.service.js";
import type { UserContext } from "../../shared/types.js";

export async function adminRoutes(app: FastifyInstance) {
  // Fixed from the reviewed version (brief §3.18): this endpoint was completely
  // unauthenticated. It now requires global admin, enforced by the same
  // mandatory middleware as everything else.
  app.get("/api/admin/logs", { config: { access: "admin" } }, async (_request, reply) => {
    const rows = await db.select().from(systemLogs).orderBy(desc(systemLogs.createdAt)).limit(200);
    return reply.send(rows);
  });

  // ── User management ──────────────────────────────────────────────────────

  app.get("/api/admin/users", { config: { access: "admin" } }, async (_request, reply) => {
    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin, suspended: users.suspended })
      .from(users);
    return reply.send(rows);
  });

  app.post("/api/admin/users", { config: { access: "admin" } }, async (request, reply) => {
    const { email, name, password } = request.body as { email: string; name: string; password: string };
    if (!email || !name || !password) {
      return reply.code(400).send({ error: "email, name, and password are required" });
    }
    // Use better-auth's sign-up API to create the user through the proper auth flow.
    const { auth } = await import("../auth/config.js");
    try {
      const result = await auth.api.signUpEmail({
        body: { email, name, password },
        headers: request.headers as any,
      } as any);
      return reply.code(201).send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? "Failed to create user" });
    }
  });

  app.patch("/api/admin/users/:id/suspend", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.update(users).set({ suspended: true }).where(eq(users.id, id));
    // Kill all sessions for the suspended user.
    await db.delete(sessions).where(eq(sessions.userId, id));
    return reply.send({ ok: true });
  });

  app.patch("/api/admin/users/:id/unsuspend", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.update(users).set({ suspended: false }).where(eq(users.id, id));
    return reply.send({ ok: true });
  });

  app.delete("/api/admin/users/:id", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reassignToId } = request.body as { reassignToId?: string };
    const actor = (request as any).userContext as UserContext;

    if (id === actor.id) return reply.code(400).send({ error: "You cannot delete your own account" });

    if (reassignToId) {
      const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, reassignToId));
      if (!target) return reply.code(400).send({ error: "Reassignment target user not found" });
      await reassignUserContent(id, reassignToId);
    } else {
      await deleteUserContent(id, actor.id);
    }

    // Sessions reference the user row (better-auth's own table).
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
    return reply.send({ ok: true });
  });

  // Export all pages owned by a user as a .zip of markdown files. Uses the
  // shared markdown + zip writers (same pipeline as the page/space export
  // routes) - no temp dirs, no external `zip` binary.
  app.get("/api/admin/users/:id/export", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id));
    if (!user) return reply.code(404).send({ error: "User not found" });

    const pageRows = await db
      .select({ id: pages.id, slug: pages.slug, title: pages.title, content: pages.content, updatedAt: pages.updatedAt })
      .from(pages)
      .where(and(eq(pages.ownerId, id), isNull(pages.deletedAt)));

    const entries: { path: string; data: Buffer }[] = [];
    const usedSlugs = new Map<string, number>();

    for (const p of pageRows) {
      const [br] = await db
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.pageId, p.id))
        .limit(1);
      if (!br) continue;

      const doc = loadDoc(p.content);
      const { markdown } = exportMarkdown(doc, {
        imageMode: "raw",
        internalLinkMode: "strip",
        frontmatter: { title: p.title, slug: p.slug, date: p.updatedAt?.toISOString() ?? null },
      });

      let filename = slugify(p.slug || p.id);
      const count = usedSlugs.get(filename) ?? 0;
      usedSlugs.set(filename, count + 1);
      if (count > 0) filename = `${filename}-${count + 1}`;

      entries.push({ path: `pages/${filename}.md`, data: Buffer.from(markdown, "utf8") });
    }

    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${(user.name ?? user.email).replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}-export.zip"`);
    return reply.send(buildZip(entries));
  });
}

/** Parse a `pages.content` column (JSON string or object) into a PM doc. */
function loadDoc(content: unknown): Parameters<typeof exportMarkdown>[0] {
  if (typeof content === "string") {
    try { return JSON.parse(content); } catch { return { type: "doc", content: [] }; }
  }
  return (content ?? { type: "doc", content: [] }) as Parameters<typeof exportMarkdown>[0];
}

function slugify(slug: string): string {
  return (slug || "page").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "page";
}
