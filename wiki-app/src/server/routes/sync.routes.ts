import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches, spaces as spacesTable } from "../db/schema.js";
import { log } from "../services/log.service.js";

const syncBody = {
  type: "object",
  required: ["targetUrl", "targetToken"],
  properties: {
    targetUrl: { type: "string" },
    targetToken: { type: "string" },
    dryRun: { type: "boolean" },
  },
} as const;

interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
}

function contentTypeToMd(content: unknown): string {
  try {
    const c = content as any;
    if (!c?.content) return "";
    return c.content
      .map((node: any) => {
        if (node.type === "heading" && node.attrs?.level === 1) {
          return `# ${node.content?.[0]?.text ?? ""}`;
        }
        if (node.type === "heading") {
          const prefix = "#".repeat(node.attrs?.level ?? 2);
          return `${prefix} ${node.content?.[0]?.text ?? ""}`;
        }
        if (node.type === "paragraph") {
          return node.content
            ?.map((n: any) => n.text ?? "")
            .join("") ?? "";
        }
        if (node.type === "bulletList") {
          return node.content
            ?.map((li: any) => `- ${li.content?.[0]?.content?.map((n: any) => n.text ?? "").join("") ?? ""}`)
            .join("\n");
        }
        if (node.type === "orderedList") {
          return node.content
            ?.map((li: any, i: number) => `${i + 1}. ${li.content?.[0]?.content?.map((n: any) => n.text ?? "").join("") ?? ""}`)
            .join("\n");
        }
        if (node.type === "codeBlock") {
          return `\`\`\`\n${node.content?.[0]?.text ?? ""}\n\`\`\``;
        }
        if (node.type === "blockquote") {
          return node.content
            ?.map((n: any) => `> ${n.content?.map((c: any) => c.text ?? "").join("") ?? ""}`)
            .join("\n");
        }
        return "";
      })
      .join("\n\n");
  } catch {
    return "";
  }
}

export async function syncRoutes(app: FastifyInstance) {
  // Initiate a sync from this instance to a target
  app.post(
    "/api/spaces/:spaceId/sync",
    {
      config: {
        access: {
          spaceParam: "spaceId",
          minRole: "admin",
        },
      },
      schema: { body: syncBody },
    },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };
      const { targetUrl, targetToken, dryRun } = request.body as {
        targetUrl: string;
        targetToken: string;
        dryRun?: boolean;
      };

      // Validate the target token works
      let targetSpaceId: string | null = null;
      try {
        const probeRes = await fetch(`${targetUrl}/api/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${targetToken}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_spaces", arguments: {} },
          }),
        });

        if (!probeRes.ok) {
          return reply.code(400).send({ error: `Target unreachable: HTTP ${probeRes.status}` });
        }

        const probeJson = await probeRes.json() as any;
        if (probeJson.error) {
          return reply.code(400).send({ error: `Target auth failed: ${probeJson.error.message}` });
        }

        // Try to find or create a matching space on the target
        const spaces = JSON.parse(probeJson.result.content[0].text);
        const [sourceSpace] = await db.select({ name: spacesTable.name }).from(spacesTable).where(eq(spacesTable.id, spaceId));
        const matching = spaces.find((s: any) => s.name === sourceSpace?.name);
        targetSpaceId = matching?.id ?? null;
      } catch (err: any) {
        return reply.code(400).send({ error: `Target probe failed: ${err.message}` });
      }

      if (!targetSpaceId) {
        return reply.code(400).send({ error: "No matching space found on target. Create it first with the same name." });
      }

      // Fetch all pages in this space
      const spaceBranches = await db
        .select({
          pageId: pages.id,
          slug: pages.slug,
          title: pages.title, // real title column (UI overhaul A5)
          content: pages.content,
          branchId: branches.id,
        })
        .from(branches)
        .innerJoin(pages, and(eq(pages.id, branches.pageId), isNull(pages.deletedAt)))
        .where(eq(branches.spaceId, spaceId));

      const syncBodyWithSpace = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "tools/call" as const,
        params: {
          name: "create_page" as const,
          arguments: {} as Record<string, unknown>,
        },
      };

      const result: SyncResult = { synced: 0, skipped: 0, errors: [] };

      for (const b of spaceBranches) {
        if (dryRun) {
          result.synced++;
          continue;
        }

        const body: typeof syncBodyWithSpace = {
          ...syncBodyWithSpace,
          params: {
            ...syncBodyWithSpace.params,
            arguments: {
              slug: b.slug,
              title: b.title, // real title column (UI overhaul A5)
              spaceId: targetSpaceId,
              content: contentTypeToMd(b.content),
            },
          },
        };

        try {
          const res = await fetch(`${targetUrl}/api/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${targetToken}`,
            },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            const text = await res.text();
            result.errors.push(`${b.slug}: HTTP ${res.status}: ${text.slice(0, 200)}`);
          } else {
            const json = await res.json() as any;
            if (json.error) {
              result.errors.push(`${b.slug}: ${json.error.message ?? String(json.error)}`);
            } else {
              result.synced++;
            }
          }
        } catch (err: any) {
          result.errors.push(`${b.slug}: ${err.message}`);
        }
      }

      log("info", "sync", `Space ${spaceId} synced to ${targetUrl}: ${result.synced} pages`);

      return reply.send({
        ok: true,
        ...result,
        dryRun: dryRun ?? false,
      });
    }
  );
}
