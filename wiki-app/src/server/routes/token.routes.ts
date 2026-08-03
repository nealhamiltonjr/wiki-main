import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { pages, branches } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createShareLink, createApiToken, resolveToken, checkTokenPassword } from "../services/token.service.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { JSONBlock } from "../../shared/blockIds.js";
import type { UserContext } from "../../shared/types.js";

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

const RANK = { none: 0, viewer: 1, editor: 2, admin: 3 } as const;

/**
 * A token's scope is taken from the REQUEST BODY, not from the URL - the
 * route's middleware only checks access on the URL's :branchId (the
 * authorization witness), so the body's scope must be cross-checked against
 * the caller's own access. Without this, an editor of one branch could mint a
 * link/token for any other branch or space (same class of bug as the
 * pageId/branchId decoupling fixed in page.routes.ts, §5.3). Rule: you can
 * only create a token for a scope you have editor-level access to, and an
 * "admin"-permission token requires a GLOBAL admin (a non-admin minting an
 * account-scoped admin token would otherwise escalate to full admin via the
 * middleware's `principal.token.permission === "admin"` branch).
 */
async function tokenScopeIsPermitted(
  user: UserContext,
  scopeType: "branch" | "space" | "account",
  scopeId: string | null,
  permission: "view" | "edit" | "admin",
): Promise<boolean> {
  if (permission === "admin") return user.isAdmin;
  if (scopeType === "account") return true; // account-scoped tokens are capped by the creator's real access

  if (scopeType === "branch") {
    try {
      const chain = await getBranchChain(scopeId!);
      const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
      const access = resolveAccess(user, chain, spaceRole);
      // Link creation is itself a privileged action - editor floor even for
      // view-permission tokens, matching the URL witness check.
      return user.isAdmin || RANK[access] >= RANK.editor;
    } catch {
      return false;
    }
  }

  // space scope
  const role = await resolveSpaceRole(user.id, scopeId!, user.groupIds);
  return user.isAdmin || (role !== null && RANK[role] >= RANK.editor);
}

export async function tokenRoutes(app: FastifyInstance) {
  // Creating a share link for a branch requires editor access on that exact
  // branch - creating a link is itself a privileged action regardless of the
  // permission level the link itself grants.
  app.post(
    "/api/branches/:branchId/share-links",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const body = createShareLinkBody.parse(request.body);
      const user = (request as any).userContext as UserContext;
      if (!(await tokenScopeIsPermitted(user, body.scopeType, body.scopeId, body.permission))) {
        return reply.code(403).send({ error: "Insufficient permissions for this link scope" });
      }
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
    const user = (request as any).userContext as UserContext;
    if (!(await tokenScopeIsPermitted(user, body.scopeType, body.scopeId, body.permission))) {
      return reply.code(403).send({ error: "Insufficient permissions for this token scope" });
    }
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

    // Rewrite embedded-image srcs so they can be fetched anonymously: the file
    // endpoint rejects unauthenticated requests, so each `/api/...` src gets the
    // share token (and, for password-protected links, the just-validated
    // password) appended. A fresh copy is returned - the stored content is never
    // mutated. External (fully-qualified) image URLs are left untouched.
    const content = rewriteShareImageSrcs(page.content as JSONBlock, rawToken, password);

    return reply.send({ slug: page.slug, content, permission: resolved.permission });
  });
}

function rewriteShareImageSrcs(doc: JSONBlock, token: string, password?: string): JSONBlock {
  if (!doc || typeof doc !== "object") return doc;
  const out: JSONBlock = { ...doc };
  if (out.type === "image" && typeof out.attrs?.src === "string" && out.attrs.src.startsWith("/api/")) {
    const sep = out.attrs.src.includes("?") ? "&" : "?";
    let src = `${out.attrs.src}${sep}shareToken=${encodeURIComponent(token)}`;
    if (password) src = `${src}&sharePassword=${encodeURIComponent(password)}`;
    out.attrs = { ...out.attrs, src };
  }
  if (Array.isArray(out.content)) {
    out.content = out.content.map((child) => rewriteShareImageSrcs(child, token, password));
  }
  return out;
}
