import type { FastifyInstance } from "fastify";
import { eq, like, and, isNull, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pages, branches, spaces as spacesTable, spaceMembers, spaceGroupPermissions } from "../db/schema.js";
import { createPage } from "../services/page.service.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import { markdownToTiptap } from "../services/markdown.service.js";
import type { UserContext } from "../../shared/types.js";

interface JsonRpcRequest { jsonrpc: "2.0"; id: number | string; method: string; params?: Record<string, unknown>; }
interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown }; }
interface McpTool { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }; }

function ok(id: number | string, result: unknown): JsonRpcResponse { return { jsonrpc: "2.0", id, result }; }
function err(id: number | string | null, code: number, message: string): JsonRpcResponse { return { jsonrpc: "2.0", id, error: { code, message } }; }

const TOOLS: McpTool[] = [
  { name: "list_spaces", description: "List all wiki spaces accessible to the authenticated user", inputSchema: { type: "object", properties: {} } },
  { name: "get_page", description: "Get a wiki page's full content by branch ID", inputSchema: { type: "object", properties: { branchId: { type: "string", description: "The branch ID of the page" } }, required: ["branchId"] } },
  { name: "search_pages", description: "Search wiki pages by slug or content text", inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] } },
  { name: "create_page", description: "Create a new wiki page in a space", inputSchema: { type: "object", properties: { slug: { type: "string" }, title: { type: "string" }, spaceId: { type: "string" }, content: { type: "string", description: "Markdown content" } }, required: ["slug", "title", "spaceId"] } },
  { name: "get_page_tree", description: "Get the page tree for a space", inputSchema: { type: "object", properties: { spaceId: { type: "string" } }, required: ["spaceId"] } },
];

const RANK = { none: 0, viewer: 1, editor: 2, admin: 3 } as const;

async function accessibleSpaceIds(user: UserContext): Promise<string[]> {
  const { db } = getDb();
  if (user.isAdmin) { const rows = await db.select({ id: spacesTable.id }).from(spacesTable); return rows.map((r) => r.id); }
  const direct = await db.select({ spaceId: spaceMembers.spaceId }).from(spaceMembers).where(eq(spaceMembers.userId, user.id));
  let viaGroups: { spaceId: string }[] = [];
  if (user.groupIds.length > 0) { viaGroups = await db.select({ spaceId: spaceGroupPermissions.spaceId }).from(spaceGroupPermissions).where(inArray(spaceGroupPermissions.groupId, user.groupIds)); }
  return [...new Set([...direct.map((r) => r.spaceId), ...viaGroups.map((r) => r.spaceId)])];
}

async function resolveBranchAccess(user: UserContext, branchId: string): Promise<"none" | "viewer" | "editor" | "admin"> {
  try { const chain = await getBranchChain(branchId); const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds); return resolveAccess(user, chain, spaceRole); } catch { return "none"; }
}

class McpError extends Error { code: number; constructor(code: number, message: string) { super(message); this.code = code; this.name = "McpError"; } }

async function callTool(name: string, args: Record<string, unknown>, user: UserContext): Promise<unknown> {
  const { db } = getDb();
  switch (name) {
    case "list_spaces": {
      const spaceIds = await accessibleSpaceIds(user);
      if (spaceIds.length === 0) return [];
      const rows = await db.select().from(spacesTable).where(inArray(spacesTable.id, spaceIds));
      return rows.map((s) => ({ id: s.id, name: s.name, createdBy: s.createdBy }));
    }
    case "get_page": {
      const branchId = args.branchId as string;
      const access = await resolveBranchAccess(user, branchId);
      if (RANK[access] < RANK.viewer) throw new McpError(-32001, "Page not found");
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) throw new McpError(-32001, "Branch not found");
      const [page] = await db.select().from(pages).where(and(eq(pages.id, branch.pageId), isNull(pages.deletedAt)));
      if (!page) throw new McpError(-32001, "Page not found");
      if (page.isEncrypted) throw new McpError(-32001, "Page is encrypted and cannot be accessed via MCP");
      return { pageId: page.id, branchId: branch.id, slug: page.slug, title: page.title, content: page.content, spaceId: branch.spaceId, access, updatedAt: page.updatedAt?.toISOString() };
    }
    case "search_pages": {
      const query = args.query as string;
      const spaceIds = await accessibleSpaceIds(user);
      if (spaceIds.length === 0) return [];
      const results = await db.select({ id: pages.id, slug: pages.slug, title: pages.title, content: pages.content, updatedAt: pages.updatedAt }).from(pages).innerJoin(branches, eq(branches.pageId, pages.id)).where(and(isNull(pages.deletedAt), inArray(branches.spaceId, spaceIds), like(pages.slug, `%${query}%`))).groupBy(pages.id).limit(20);
      const visible: typeof results = [];
      for (const r of results) { const branchRows = await db.select({ id: branches.id }).from(branches).where(eq(branches.pageId, r.id)); for (const b of branchRows) { if (RANK[(await resolveBranchAccess(user, b.id))] >= RANK.viewer) { visible.push(r); break; } } }
      return visible.map((r) => ({ id: r.id, slug: r.slug, title: r.title, snippet: typeof r.content === "string" ? r.content.slice(0, 300) : JSON.stringify(r.content).slice(0, 300), updatedAt: r.updatedAt?.toISOString() }));
    }
    case "create_page": {
      const { slug, title, spaceId } = args as { slug: string; title: string; spaceId: string };
      if (!user.isAdmin) { const role = await resolveSpaceRole(user.id, spaceId, user.groupIds); if (!role || (role !== "editor" && role !== "admin")) throw new McpError(-32001, "Insufficient space permissions"); }
      const bodyMd = typeof args.content === "string" ? args.content : "";
      const content = bodyMd.trim() ? markdownToTiptap(bodyMd) : undefined;
      const result = await createPage({ slug, title, ownerId: user.id, spaceId, parentBranchId: null, initialContent: content });
      return { ...result, slug };
    }
    case "get_page_tree": {
      const spaceId = args.spaceId as string;
      if (!user.isAdmin) { const role = await resolveSpaceRole(user.id, spaceId, user.groupIds); if (!role) throw new McpError(-32001, "Space not found"); }
      const rows = await db.select({ branchId: branches.id, pageId: branches.pageId, parentId: branches.parentBranchId, slug: pages.slug }).from(branches).innerJoin(pages, and(eq(pages.id, branches.pageId), isNull(pages.deletedAt))).where(eq(branches.spaceId, spaceId));
      return rows;
    }
    default: throw new McpError(-32601, `Unknown tool: ${name}`);
  }
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post("/api/mcp", { config: { access: "authenticated" } }, async (request, reply) => {
    const user = (request as any).userContext as UserContext;
    const body = request.body as JsonRpcRequest;
    if (!body || body.jsonrpc !== "2.0" || !body.method) return reply.send(err(null, -32600, "Invalid Request"));
    try {
      switch (body.method) {
        case "initialize": return reply.send(ok(body.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "wiki-app-v2", version: "0.1.0" } }));
        case "tools/list": return reply.send(ok(body.id, { tools: TOOLS }));
        case "tools/call": {
          const params = body.params as { name?: string; arguments?: Record<string, unknown> };
          if (!params?.name) return reply.send(err(body.id, -32602, "Missing tool name"));
          const result = await callTool(params.name, params.arguments ?? {}, user);
          return reply.send(ok(body.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }));
        }
        case "notifications/initialized": return reply.send(ok(body.id, {}));
        default: return reply.send(err(body.id, -32601, `Method not found: ${body.method}`));
      }
    } catch (e: unknown) {
      if (e instanceof McpError) return reply.send(err(body.id, e.code, e.message));
      const msg = e instanceof Error ? e.message : String(e);
      return reply.send(err(body.id, -32603, `Internal error: ${msg}`));
    }
  });
}
