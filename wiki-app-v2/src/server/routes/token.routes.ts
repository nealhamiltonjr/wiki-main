import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { auditLog, tokens } from "../db/schema.js";
import { createApiToken } from "../services/token.service.js";

const createTokenBody = z.object({
  name: z.string().min(1).max(200),
  scopeType: z.enum(["account", "space", "branch"]),
  scopeId: z.string().nullable().optional(),
  permission: z.enum(["view", "edit", "admin"]),
  expiresAt: z.string().datetime().nullable().optional(), // ISO; null = no expiration
}).strict();

function toPublicToken(row: typeof tokens.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    scopeType: row.scopeType,
    permission: row.permission,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastAccessedAt: row.lastAccessedAt,
  };
}

/**
 * §7.1 Tokens — API token management for the signed-in user. Share-link
 * management stays page-contextual (a link is tied to a specific page's share
 * action); this surface owns account-level API tokens.
 */
export async function tokenRoutes(app: FastifyInstance) {
  app.get("/api/tokens", { config: { access: "authenticated" } }, async (request, reply) => {
    const user = (request as any).userContext;
    const { db } = getDb();
    const rows = await db
      .select()
      .from(tokens)
      .where(and(eq(tokens.createdBy, user.id), eq(tokens.type, "api_token")));
    return reply.send(rows.map(toPublicToken));
  });

  app.post("/api/tokens", { config: { access: "authenticated" } }, async (request, reply) => {
    const body = createTokenBody.parse(request.body);
    const user = (request as any).userContext as { id: string; isAdmin: boolean };

    // Non-admins get account-scoped tokens only — a token cannot silently widen
    // the holder's reach beyond what their session already allows.
    if (body.scopeType !== "account" && !user.isAdmin) {
      return reply.code(403).send({ error: "Only admins can create space or branch-scoped tokens" });
    }
    if (body.scopeType === "account" && body.scopeId) {
      return reply.code(400).send({ error: "Account-scoped tokens must not carry a scope id" });
    }

    const { rawToken, id } = await createApiToken({
      createdBy: user.id,
      isAdmin: user.isAdmin,
      scopeType: body.scopeType,
      scopeId: body.scopeType === "account" ? null : (body.scopeId ?? null),
      permission: body.permission,
      expiresAt: body.expiresAt === undefined ? null : body.expiresAt ? new Date(body.expiresAt) : null,
      name: body.name,
    }).catch((err) => {
      // No-expiration tokens are permissioned (§3.10) — surface the capability
      // gate as a 403 instead of a 500 so the UI can explain it.
      if (err instanceof Error && err.message === "NO_EXPIRATION_NOT_PERMITTED") {
        const e = new Error("Expiration-less tokens require admin (or the link-managers group)");
        (e as any).statusCode = 403;
        throw e;
      }
      throw err;
    });

    const { db } = getDb();
    await db.insert(auditLog).values({
      actorUserId: user.id,
      action: "token_create",
      targetType: "token",
      targetId: id,
      meta: { scopeType: body.scopeType, permission: body.permission },
    });

    // The raw value exists exactly once — after this response only the hash is
    // stored, so the client must surface it immediately.
    return reply.code(201).send({ id, token: rawToken, name: body.name, scopeType: body.scopeType, permission: body.permission });
  });

  app.delete("/api/tokens/:id", { config: { access: "authenticated" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).userContext as { id: string; isAdmin: boolean };
    const { db } = getDb();
    const [row] = await db
      .select()
      .from(tokens)
      .where(and(eq(tokens.id, id), eq(tokens.type, "api_token")));
    if (!row) return reply.code(404).send({ error: "Token not found" });
    if (row.createdBy !== user.id && !user.isAdmin) {
      return reply.code(403).send({ error: "You can only revoke your own tokens" });
    }
    if (!row.revokedAt) {
      await db.update(tokens).set({ revokedAt: new Date() }).where(eq(tokens.id, id));
      await db.insert(auditLog).values({
        actorUserId: user.id,
        action: "token_revoke",
        targetType: "token",
        targetId: id,
      });
    }
    return reply.code(204).send();
  });
}
