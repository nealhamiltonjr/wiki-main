import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { spaces as spacesTable, pages, branches } from "../db/schema.js";

const syncBody = z.object({ spaceId: z.string().min(1), targetUrl: z.string().url().max(500).regex(/^https?:\/\//, "URL must be http(s)"), targetToken: z.string().min(1).max(200) }).strict();

export async function syncRoutes(app: FastifyInstance) {
  app.post("/api/sync/push", { config: { access: "admin" } }, async (request, reply) => {
    const body = syncBody.parse(request.body);
    const { db } = getDb();
    const [space] = await db.select().from(spacesTable).where(eq(spacesTable.id, body.spaceId));
    if (!space) return reply.code(404).send({ error: "Space not found" });
    const pageRows = await db.select({ pageId: pages.id, slug: pages.slug, title: pages.title, content: pages.content, updatedAt: pages.updatedAt }).from(pages).innerJoin(branches, eq(branches.pageId, pages.id)).where(and(eq(branches.spaceId, body.spaceId), isNull(pages.deletedAt))).groupBy(pages.id);
    const remoteBase = body.targetUrl.replace(/\/$/, "");
    let synced = 0, skipped = 0; const errors: string[] = [];
    try {
      const listRes = await fetch(`${remoteBase}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${body.targetToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_spaces" } }) });
      if (!listRes.ok) return reply.code(502).send({ error: `Remote MCP failed: ${listRes.status}` });
      const listJson = await listRes.json() as { result?: { content?: { text: string }[] } };
      const remoteSpaces = JSON.parse(listJson.result?.content?.[0]?.text ?? "[]") as { id: string; name: string }[];
      let targetSpaceId = remoteSpaces.find((s) => s.name === space.name)?.id;
      if (!targetSpaceId) { const createSpaceRes = await fetch(`${remoteBase}/api/spaces`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${body.targetToken}` }, body: JSON.stringify({ name: space.name }) }); if (!createSpaceRes.ok) return reply.code(502).send({ error: `Remote space creation failed` }); const created = await createSpaceRes.json() as { id: string }; targetSpaceId = created.id; }
      for (const page of pageRows) {
        try {
          const { exportMarkdown } = await import("../services/markdown.service.js");
          const { markdown } = exportMarkdown(page.content as never, { imageMode: "raw" });
          const createRes = await fetch(`${remoteBase}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${body.targetToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_page", arguments: { slug: page.slug, title: page.title, spaceId: targetSpaceId, content: markdown } } }) });
          if (createRes.ok) synced++; else { skipped++; errors.push(`create_page for ${page.slug} returned ${createRes.status}`); }
        } catch (err) { skipped++; errors.push(`create_page for ${page.slug}: ${(err as Error).message}`); }
      }
      return reply.send({ synced, skipped, errors, targetSpaceId, targetUrl: remoteBase });
    } catch (err) { return reply.code(502).send({ error: `Sync failed: ${(err as Error).message}` }); }
  });
}
