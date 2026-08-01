import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { pages, branches } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createShareLink, createApiToken, resolveToken, checkTokenPassword } from "../services/token.service.js";

// Nullable ISO datetime input, coerced from a JSON string to a Date on the
// server side. z.coerce.date() is tempting but silently converts null →
// Date(0) before .nullable() can catch it, turning deliberate no-expiration
// requests into already-expired links (§3.10 / §5.9).
const expiresAtField = z
  .string()
  .datetime()
  .nullable()
  .transform((v) => (v ? new Date(v) : null));

const createShareLinkBody = z.object({
  scopeType: z.enum(["branch", "space"]),
  scopeId: z.string(),
  permission: z.enum(["view", "edit"]),
  expiresAt: expiresAtField,
  password: z.string().optional(),
  name: z.string().optional(),
});

const createApiTokenBody = z.object({
  scopeType: z.enum(["branch", "space", "account"]),
  scopeId: z.string().nullable(),
  permission: z.enum(["view", "edit", "admin"]),
  expiresAt: expiresAtField,
  name: z.string().optional(),
});

export async function tokenRoutes(app: FastifyInstance) {
  // Creating a share link for a branch requires editor access on that exact
  // branch - creating a link is itself a privileged action regardless of the
  // permission level the link itself grants.
  app.post(
    "/api/branches/:branchId/share-links",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const body = createShareLinkBody.parse(request.body);
      const user = (request as any).userContext;
      try {
        const result = await createShareLink({
          branchOrSpaceId: body.scopeId,
          scopeType: body.scopeType,
          createdBy: user.id,
          isAdmin: user.isAdmin,
          permission: body.permission,
          expiresAt: body.expiresAt,
          password: body.password,
          name: body.name,
        });
        return reply.code(201).send({ id: result.id, token: result.rawToken });
      } catch (err) {
        if (err instanceof Error && err.message === "NO_EXPIRATION_NOT_PERMITTED") {
          return reply.code(403).send({ error: "You don't have permission to create a non-expiring link" });
        }
        throw err;
      }
    }
  );

  app.post("/api/tokens", { config: { access: "authenticated" } }, async (request, reply) => {
    const body = createApiTokenBody.parse(request.body);
    const user = (request as any).userContext;
    try {
      const result = await createApiToken({
        createdBy: user.id,
        isAdmin: user.isAdmin,
        scopeType: body.scopeType,
        scopeId: body.scopeId,
        permission: body.permission,
        expiresAt: body.expiresAt,
        name: body.name,
      });
      return reply.code(201).send({ id: result.id, token: result.rawToken });
    } catch (err) {
      if (err instanceof Error && err.message === "NO_EXPIRATION_NOT_PERMITTED") {
        return reply.code(403).send({ error: "You don't have permission to create a non-expiring token" });
      }
      if (err instanceof Error && err.message === "ACCOUNT_SCOPE_MUST_HAVE_NULL_SCOPE_ID") {
        return reply.code(400).send({ error: "Account-scoped tokens must not specify a branch or space" });
      }
      throw err;
    }
  });

  // Public, unauthenticated view path for a share-link token. Deliberately its
  // OWN access path (config: "public") rather than going through the normal
  // branchParam permission check - a share-link token is a bearer capability
  // scoped to exactly one branch/space, not a stand-in for a logged-in user's
  // permissions (brief §3.10's critical rule: never account-scoped).
  app.get("/api/share/:token", { config: { access: "public" } }, async (request, reply) => {
    const { token: rawToken } = request.params as { token: string };
    const { password } = request.query as { password?: string };

    const resolved = await resolveToken(rawToken);
    if (!resolved) return reply.code(404).send({ error: "Link not found or expired" });
    if (!checkTokenPassword(resolved, password)) return reply.code(401).send({ error: "Password required" });

    if (resolved.scopeType !== "branch") {
      return reply.code(400).send({ error: "Only branch-scoped share links can be viewed directly" });
    }

    const [branch] = await db.select().from(branches).where(eq(branches.id, resolved.scopeId!));
    if (!branch) return reply.code(404).send({ error: "Content no longer exists" });
    const [page] = await db.select().from(pages).where(eq(pages.id, branch.pageId));
    if (!page || page.deletedAt) return reply.code(404).send({ error: "Content no longer exists" });

    return reply.send({ slug: page.slug, content: page.content, permission: resolved.permission });
  });
}
