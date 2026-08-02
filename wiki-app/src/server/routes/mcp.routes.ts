import type { FastifyInstance } from "fastify";
import { eq, like, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches, spaces as spacesTable, spaceMembers, spaceGroupPermissions } from "../db/schema.js";
import { createPage } from "../services/page.service.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import { markdownToTiptap } from "../services/markdown.service.js";
import type { UserContext } from "../../shared/types.js";

// JSON-RPC 2.0 types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

function ok(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOLS: McpTool[] = [
  {
    name: "list_spaces",
    description: "List all wiki spaces accessible to the authenticated user",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_page",
    description: "Get a wiki page's full content by branch ID",
    inputSchema: {
      type: "object",
      properties: { branchId: { type: "string", description: "The branch ID of the page" } },
      required: ["branchId"],
    },
  },
  {
    name: "search_pages",
    description: "Search wiki pages by slug or content text",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query (matches slug prefix or JSON content substring)" } },
      required: ["query"],
    },
  },
  {
    name: "create_page",
    description: "Create a new wiki page in a space",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "URL-friendly page slug" },
        title: { type: "string", description: "Page title (becomes H1)" },
        spaceId: { type: "string", description: "Target space ID" },
        content: { type: "string", description: "Markdown content for the page body" },
      },
      required: ["slug", "title", "spaceId"],
    },
  },
  {
    name: "get_page_tree",
    description: "Get the page tree for a space",
    inputSchema: {
      type: "object",
      properties: { spaceId: { type: "string", description: "Space ID" } },
      required: ["spaceId"],
    },
  },
];

const RANK = { none: 0, viewer: 1, editor: 2, admin: 3 } as const;

/** Accessible space ids for a user — mirrors GET /api/spaces (direct membership, group grants, or all for admins). */
async function accessibleSpaceIds(user: UserContext): Promise<string[]> {
  if (user.isAdmin) {
    const rows = await db.select({ id: spacesTable.id }).from(spacesTable);
    return rows.map((r) => r.id);
  }
  const direct = await db.select({ spaceId: spaceMembers.spaceId }).from(spaceMembers).where(eq(spaceMembers.userId, user.id));
  let viaGroups: { spaceId: string }[] = [];
  if (user.groupIds.length > 0) {
    viaGroups = await db
      .select({ spaceId: spaceGroupPermissions.spaceId })
      .from(spaceGroupPermissions)
      .where(sql`${spaceGroupPermissions.groupId} IN ${user.groupIds}`);
  }
  return [...new Set([...direct.map((r) => r.spaceId), ...viaGroups.map((r) => r.spaceId)])];
}

/** Resolves access on a branch through the same permission algorithm the REST routes use. */
async function resolveBranchAccess(user: UserContext, branchId: string): Promise<"none" | "viewer" | "editor" | "admin"> {
  try {
    const chain = await getBranchChain(branchId);
    const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
    return resolveAccess(user, chain, spaceRole);
  } catch {
    return "none";
  }
}

async function callTool(name: string, args: Record<string, unknown>, user: UserContext): Promise<unknown> {
  switch (name) {
    case "list_spaces": {
      const spaceIds = await accessibleSpaceIds(user);
      if (spaceIds.length === 0) return [];
      const rows = await db.select().from(spacesTable).where(sql`${spacesTable.id} IN ${spaceIds}`);
      return rows.map((s) => ({ id: s.id, name: s.name, createdBy: s.createdBy }));
    }

    case "get_page": {
      const branchId = args.branchId as string;
      const access = await resolveBranchAccess(user, branchId);
      if (RANK[access] < RANK.viewer) throw { code: -32001, message: "Page not found" };
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) throw { code: -32001, message: "Branch not found" };
      const [page] = await db.select().from(pages).where(and(eq(pages.id, branch.pageId), isNull(pages.deletedAt)));
      if (!page) throw { code: -32001, message: "Page not found" };
      return {
        pageId: page.id,
        branchId: branch.id,
        slug: page.slug,
        content: page.content,
        spaceId: branch.spaceId,
        access,
        updatedAt: page.updatedAt?.toISOString(),
      };
    }

    case "search_pages": {
      const query = args.query as string;
      const spaceIds = await accessibleSpaceIds(user);
      if (spaceIds.length === 0) return [];
      const results = await db
        .select({ id: pages.id, slug: pages.slug, content: pages.content, updatedAt: pages.updatedAt })
        .from(pages)
        .innerJoin(branches, eq(branches.pageId, pages.id))
        .where(
          and(
            isNull(pages.deletedAt),
            sql`${branches.spaceId} IN ${spaceIds}`,
            like(pages.slug, `%${query}%`),
          )
        )
        .groupBy(pages.id)
        .limit(20);
      return results.map((r) => ({
        id: r.id,
        slug: r.slug,
        snippet: typeof r.content === "string" ? r.content.slice(0, 300) : JSON.stringify(r.content).slice(0, 300),
        updatedAt: r.updatedAt?.toISOString(),
      }));
    }

    case "create_page": {
      const { slug, title, spaceId } = args;
      if (!user.isAdmin) {
        const role = await resolveSpaceRole(user.id, spaceId as string, user.groupIds);
        if (!role || (role !== "editor" && role !== "admin")) {
          throw { code: -32001, message: "Insufficient space permissions" };
        }
      }
      const bodyMd = typeof args.content === "string" ? args.content : "";
      const fullMd = `# ${title}\n\n${bodyMd}`;
      const content = markdownToTiptap(fullMd);
      const result = await createPage({
        slug: slug as string,
        ownerId: user.id,
        spaceId: spaceId as string,
        parentBranchId: null,
        initialContent: content,
      });
      return { ...result, slug: slug as string };
    }

    case "get_page_tree": {
      const spaceId = args.spaceId as string;
      if (!user.isAdmin) {
        const role = await resolveSpaceRole(user.id, spaceId as string, user.groupIds);
        if (!role) throw { code: -32001, message: "Space not found" };
      }
      const rows = await db
        .select({ branchId: branches.id, pageId: branches.pageId, parentId: branches.parentBranchId, slug: pages.slug })
        .from(branches)
        .innerJoin(pages, and(eq(pages.id, branches.pageId), isNull(pages.deletedAt)))
        .where(eq(branches.spaceId, spaceId));
      return rows;
    }

    default:
      throw { code: -32601, message: `Unknown tool: ${name}` };
  }
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post(
    "/api/mcp",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const user = (request as any).userContext as UserContext;
      const body = request.body as JsonRpcRequest;

      if (!body || body.jsonrpc !== "2.0" || !body.method) {
        return reply.send(err(null, -32600, "Invalid Request"));
      }

      try {
        switch (body.method) {
          case "initialize":
            return reply.send(ok(body.id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "wiki-app", version: "0.1.0" },
            }));

          case "tools/list":
            return reply.send(ok(body.id, { tools: TOOLS }));

          case "tools/call": {
            const params = body.params as { name?: string; arguments?: Record<string, unknown> };
            if (!params?.name) return reply.send(err(body.id, -32602, "Missing tool name"));
            const result = await callTool(params.name, params.arguments ?? {}, user);
            return reply.send(ok(body.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }));
          }

          case "notifications/initialized":
            return reply.send(ok(body.id, {}));

          default:
            return reply.send(err(body.id, -32601, `Method not found: ${body.method}`));
        }
      } catch (e: any) {
        if (e.code && e.message) {
          return reply.send(err(body.id, e.code, e.message));
        }
        return reply.send(err(body.id, -32603, `Internal error: ${e.message ?? String(e)}`));
      }
    }
  );
}
