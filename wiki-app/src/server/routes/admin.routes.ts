import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { systemLogs, users, pages, comments, sessions, branches } from "../db/schema.js";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

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

    if (reassignToId) {
      // Reassign pages and comments to another user before deleting.
      await db
        .update(pages)
        .set({ ownerId: reassignToId })
        .where(eq(pages.ownerId, id));
      await db
        .update(comments)
        .set({ userId: reassignToId })
        .where(eq(comments.userId, id));
    }

    // Delete sessions first (FK constraint in some setups).
    await db.delete(sessions).where(eq(sessions.userId, id));
    await db.delete(users).where(eq(users.id, id));
    return reply.send({ ok: true });
  });

  // Export all pages owned by a user as a .zip of markdown files.
  app.get("/api/admin/users/:id/export", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [user] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id));
    if (!user) return reply.code(404).send({ error: "User not found" });

    const pageRows = await db
      .select({ pageId: pages.id, slug: pages.slug, ownerId: pages.ownerId })
      .from(pages)
      .where(eq(pages.ownerId, id));

    const tmpDir = resolve(process.cwd(), "data", "export-" + id);
    const outDir = resolve(tmpDir, user.name || user.email);
    mkdirSync(outDir, { recursive: true });

    for (const p of pageRows) {
      const [br] = await db
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.pageId, p.pageId))
        .limit(1);
      if (!br) continue;

      const [snap] = await db
        .select({ content: pages.content })
        .from(pages)
        .where(eq(pages.id, p.pageId));
      const content = (snap?.content as any)?.content;
      const md = jsonToMarkdown(content);
      const filename = p.slug || p.pageId;
      const f = createWriteStream(resolve(outDir, `${filename}.md`));
      f.write(`# ${filename}\n\n`);
      f.write(md);
      f.end(new Promise((r) => f.on("close", r)));
    }

    const zipPath = resolve(tmpDir, "export.zip");
    execSync(`cd "${tmpDir}" && zip -r "${zipPath}" .`, { stdio: "pipe" });

    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${user.name ?? user.email}-export.zip"`);

    const { readFileSync } = await import("node:fs");
    const buf = readFileSync(zipPath);
    await reply.send(buf);

    // Clean up temp dir after response.
    setTimeout(() => rmSync(tmpDir, { recursive: true, force: true }), 5000);
  });
}

function jsonToMarkdown(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node + "\n";
  if ("text" in node) return node.text || "";
  if (node.type === "paragraph") return (node.content || []).map(jsonToMarkdown).join("") + "\n\n";
  if (node.type === "heading") return "#".repeat(node.attrs?.level ?? 1) + " " + (node.content || []).map(jsonToMarkdown).join("") + "\n\n";
  if (node.type === "bulletList") return (node.content || []).map((item: any) => "* " + (item.content || []).map(jsonToMarkdown).join("")).join("\n") + "\n\n";
  if (node.type === "orderedList") return (node.content || []).map((item: any, i: number) => `${i + 1}. ` + (item.content || []).map(jsonToMarkdown).join("")).join("\n") + "\n\n";
  if (node.type === "codeBlock") return "```\n" + ((node.content || [])[0]?.text || "") + "\n```\n\n";
  if (node.type === "blockquote") return "> " + (node.content || []).map(jsonToMarkdown).join("") + "\n\n";
  if (node.type === "horizontalRule") return "---\n\n";
  if (node.type === "image") return `![${node.attrs?.alt || ""}](${node.attrs?.src || ""})\n\n`;
  if (node.type === "taskList") return (node.content || []).map((item: any) => {
    const checked = item.attrs?.checked ? "x" : " ";
    return `- [${checked}] ` + (item.content || []).map(jsonToMarkdown).join("");
  }).join("\n") + "\n\n";
  if (node.content) return (node.content || []).map(jsonToMarkdown).join("");
  return "";
}
