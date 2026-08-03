import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { branches } from "../db/schema.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import { getUserContext, getUserContextById } from "../services/auth.service.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveToken, checkTokenPassword, type ResolvedToken } from "../services/token.service.js";
import type { AccessResult, BranchContext, SpaceRole, TokenPermission, UserContext } from "../../shared/types.js";

/**
 * Every route MUST declare its access requirement via `config.access` at
 * registration time. There is no way to register a route without one - see the
 * fail-closed check in the hook below. This is the direct structural fix for the
 * finding in brief §3.18: the permission algorithm was written correctly but
 * never actually invoked from any route in the reviewed implementation. Making
 * the check declarative and hook-driven, rather than something each handler has
 * to remember to call, means a forgotten check fails the request instead of
 * silently allowing it.
 */
export type RouteAccess =
  | "public" // no auth required at all - e.g. the unauthenticated public-branch view route
  | "authenticated" // any logged-in user, no specific branch/role check (e.g. "list my spaces")
  | "admin" // global admin only
  | { branchParam: string; minRole: Exclude<AccessResult, "none">; source?: "params" | "query" | "body"; allowShareToken?: true }
  | { spaceParam: string; minRole: SpaceRole; source?: "params" | "query" | "body" }; // for routes with no single "the" branch, e.g. listing a space's whole tree

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

export async function registerPermissionMiddleware(app: FastifyInstance) {
  // Validated at REGISTRATION time, not guessed at request time: any /api/
  // route (other than /api/auth/*, which establishes identity rather than
  // requiring it) must declare `config.access`, or the server refuses to
  // start. This replaced an earlier attempt to detect "is this actually a
  // real route, or Fastify's own internal not-found dispatch" by sniffing the
  // shape of `request.routeOptions` at request time - found during production
  // testing to be unreliable, since Fastify's internal fallback route's shape
  // wasn't consistent enough to distinguish from a genuinely misconfigured
  // route. Failing fast at startup is both simpler and a better developer
  // experience than a per-request 500 discovered later.
  app.addHook("onRoute", (routeOptions) => {
    const url = typeof routeOptions.url === "string" ? routeOptions.url : "";
    if (!url.startsWith("/api/") || url.startsWith("/api/auth/")) return;
    if (!routeOptions.config?.access) {
      throw new Error(
        `Route ${JSON.stringify(routeOptions.method)} ${url} does not declare config.access - every /api/ route must (see middleware/permissions.ts)`
      );
    }
  });

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // Anything outside /api/ (the static frontend, its assets, Fastify's own
    // not-found dispatch for non-API paths) is out of scope for this check
    // entirely - the protected surface is the API, not the static shell.
    if (!request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/auth/")) return;

    const access = request.routeOptions.config?.access;

    // With the onRoute validation above, every one of OUR OWN /api/ routes is
    // guaranteed to have this set. Reaching here with it undefined means this
    // request didn't match any of our routes at all (framework-level 404
    // dispatch for an /api/ path) - safe to let it fall through to the actual
    // 404 handling rather than treating it as a security failure.
    if (access === undefined) return;

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }

    // A request is authenticated either by a better-auth session cookie or by a
    // bearer API token (Authorization: Bearer <token>). Bearer takes precedence
    // when present - and an invalid bearer credential is a hard 401, never a
    // silent fallback to the session.
    const principal = await getPrincipal(headers);
    if (principal) {
      // Principal kind is exposed to handlers so routes can apply extra
      // scope-aware filtering (e.g. a branch-scoped token must not see the
      // whole space tree) beyond the single-URL access check.
      (request as any).principalKind = principal.kind;
      if (principal.kind === "token") {
        (request as any).tokenScope = {
          scopeType: principal.token.scopeType,
          scopeId: principal.token.scopeId,
          permission: principal.token.permission,
        };
      }
    }
    if (principal?.kind === "user") {
      (request as any).userContext = principal.user;
    } else if (principal?.kind === "token") {
      // Every token carries a creator; handlers use that identity for
      // attribution (ownerId, uploadedBy, ...). Access control is separate:
      // the token's own scope/permission is enforced below, not the creator's.
      const creator = await getUserContextById(principal.token.createdBy).catch(() => null);
      if (!creator) return reply.code(401).send({ error: "Token owner not found" });
      (request as any).userContext = creator;
    }

    if (access === "public") return;

    // A branch-scoped route may opt in to share-link (token-in-URL) access so an
    // anonymous viewer of a shared page can load its embedded assets (images).
    // The token grants access to the branch it scopes to, any SIBLING branch of
    // the same page (image srcs are branch-bound but page content is shared
    // across all of a page's branches), or any branch of the space a space-scoped
    // token covers. Password-protected links additionally require the password.
    // Authenticated principals never reach this path.
    if (!principal && typeof access === "object" && "branchParam" in access && access.allowShareToken) {
      const source = (request as any)[access.source ?? "params"] as Record<string, unknown>;
      const branchId = source?.[access.branchParam];
      const query = request.query as Record<string, unknown>;
      const rawToken = query?.shareToken;
      if (typeof branchId === "string" && typeof rawToken === "string" && rawToken) {
        const token = await resolveToken(rawToken);
        if (token && token.type === "share_link") {
          if (token.passwordHash) {
            const pw = query?.sharePassword;
            if (!checkTokenPassword(token, typeof pw === "string" ? pw : undefined)) {
              return reply.code(401).send({ error: "Password required" });
            }
          }
          let chain;
          try {
            chain = await getBranchChain(branchId);
          } catch {
            return reply.code(404).send({ error: "Branch not found" });
          }
          const scopeOk = await shareTokenCoversBranch(token, branchId, chain);
          if (scopeOk) {
            const granted = token.scopeType === "branch" ? tokenBranchAccess(token.permission) : tokenSpaceAccess(token.permission);
            if (meetsMinimum(granted, access.minRole)) {
              (request as any).resolvedAccess = granted;
              (request as any).branchChain = chain;
              return;
            }
          }
        }
      }
      return reply.code(401).send({ error: "Authentication required" });
    }

    if (!principal) return reply.code(401).send({ error: "Authentication required" });

    if (access === "authenticated") {
      // Branch/space-scoped tokens are scoped credentials, not general logins -
      // they can only be used on routes that carry a matching branch/space.
      if (principal.kind === "token" && principal.token.scopeType !== "account") {
        return reply.code(403).send({ error: "This token cannot be used for this route" });
      }
      return;
    }

    if (access === "admin") {
      const isAdmin =
        principal.kind === "user"
          ? principal.user.isAdmin
          : principal.token.scopeType === "account" && principal.token.permission === "admin";
      if (!isAdmin) return reply.code(403).send({ error: "Admin access required" });
      return;
    }

    if ("spaceParam" in access) {
      const source = (request as any)[access.source ?? "params"] as Record<string, unknown>;
      const spaceId = source?.[access.spaceParam];
      if (typeof spaceId !== "string") return reply.code(400).send({ error: `Missing ${access.spaceParam}` });

      if (principal.kind === "token") {
        // A space-scoped token is its own grant for that exact space.
        if (principal.token.scopeType === "space" && principal.token.scopeId === spaceId) {
          const role = tokenSpaceAccess(principal.token.permission);
          if (rank(role) < rank(access.minRole)) {
            return reply.code(403).send({ error: "Insufficient space permissions" });
          }
          (request as any).resolvedSpaceRole = role;
          return;
        }
        // Account-scoped token: act as the creator, capped by the token permission.
        if (principal.token.scopeType === "account") {
          const creator = (request as any).userContext as UserContext;
          const role = await resolveSpaceRole(creator.id, spaceId, creator.groupIds);
          const effective = role ? capSpaceRole(role, principal.token.permission) : null;
          if (!effective || rank(effective) < rank(access.minRole)) {
            return reply.code(403).send({ error: "Insufficient space permissions" });
          }
          (request as any).resolvedSpaceRole = effective;
          return;
        }
        return reply.code(403).send({ error: "Insufficient space permissions" });
      }

      if (principal.user.isAdmin) return; // admin bypasses space-level checks too, consistent with §3.8
      const role = await resolveSpaceRole(principal.user.id, spaceId, principal.user.groupIds);
      if (!role || rank(role) < rank(access.minRole)) {
        return reply.code(403).send({ error: "Insufficient space permissions" });
      }
      (request as any).resolvedSpaceRole = role;
      return;
    }

    // { branchParam, minRole } case - the common one, used by every branch/page-scoped route.
    const source = (request as any)[access.source ?? "params"] as Record<string, unknown>;
    const branchId = source?.[access.branchParam];
    if (typeof branchId !== "string") {
      return reply.code(400).send({ error: `Missing ${access.branchParam}` });
    }

    let chain;
    try {
      chain = await getBranchChain(branchId);
    } catch {
      return reply.code(404).send({ error: "Branch not found" });
    }

    if (principal.kind === "token") {
      let granted: AccessResult;
      if (principal.token.scopeType === "branch" && principal.token.scopeId === branchId) {
        granted = tokenBranchAccess(principal.token.permission);
      } else if (principal.token.scopeType === "space" && principal.token.scopeId === chain[0]!.spaceId) {
        granted = tokenSpaceAccess(principal.token.permission);
      } else if (principal.token.scopeType === "account") {
        const creator = (request as any).userContext as UserContext;
        const spaceRole = await resolveSpaceRole(creator.id, chain[0]!.spaceId, creator.groupIds);
        granted = capAccess(resolveAccess(creator, chain, spaceRole), principal.token.permission);
      } else {
        return reply.code(403).send({ error: "Insufficient permissions" });
      }

      if (!meetsMinimum(granted, access.minRole)) {
        return reply.code(403).send({ error: "Insufficient permissions" });
      }
      (request as any).resolvedAccess = granted;
      (request as any).branchChain = chain;
      return;
    }

    const spaceRole = await resolveSpaceRole(principal.user.id, chain[0]!.spaceId, principal.user.groupIds);
    const result = resolveAccess(principal.user, chain, spaceRole);

    if (!meetsMinimum(result, access.minRole)) {
      return reply.code(403).send({ error: "Insufficient permissions" });
    }

    (request as any).resolvedAccess = result;
    (request as any).branchChain = chain;
  });
}

/**
 * Whether a share-link token covers a given branch. Branch-scoped tokens cover
 * the exact branch they name AND any sibling branch of the same page - image
 * srcs are branch-bound but page content (and its files) is shared across every
 * branch of a page, so a share of one branch must render images whose URLs
 * reference another. Space-scoped tokens cover any branch in that space.
 */
async function shareTokenCoversBranch(token: ResolvedToken, branchId: string, chain: BranchContext[]): Promise<boolean> {
  if (token.scopeType === "space") return chain[0]!.spaceId === token.scopeId;
  if (token.scopeType !== "branch" || !token.scopeId) return false;
  if (token.scopeId === branchId) return true;

  const [tokenBranch] = await db.select({ pageId: branches.pageId }).from(branches).where(eq(branches.id, token.scopeId));
  const [urlBranch] = await db.select({ pageId: branches.pageId }).from(branches).where(eq(branches.id, branchId));
  if (!tokenBranch || !urlBranch) return false;
  return tokenBranch.pageId === urlBranch.pageId;
}

const rankMap: Record<AccessResult, number> = { none: 0, viewer: 1, editor: 2, admin: 3 };

function rank(a: AccessResult): number {
  return rankMap[a];
}

function meetsMinimum(actual: AccessResult, min: Exclude<AccessResult, "none">): boolean {
  return rankMap[actual] >= rankMap[min];
}

type Principal =
  | { kind: "user"; user: UserContext }
  | { kind: "token"; token: ResolvedToken };

/**
 * Resolves the request's principal: a bearer token if an Authorization header
 * is present, otherwise the session. Password-protected tokens are deliberately
 * NOT usable as bearer credentials - the public share-link view performs its own
 * password check, and there is no defined way to supply a password over the API,
 * so allowing them here would silently bypass the protection.
 */
async function getPrincipal(headers: Headers): Promise<Principal | null> {
  const authHeader = headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const raw = authHeader.slice("Bearer ".length).trim();
    if (raw) {
      const token = await resolveToken(raw);
      if (token && !token.passwordHash) return { kind: "token", token };
    }
    return null;
  }

  const user = await getUserContext(headers);
  return user ? { kind: "user", user } : null;
}

/** Branch-level roles top out at editor - there is no branch-level admin. */
function tokenBranchAccess(permission: TokenPermission): AccessResult {
  return permission === "view" ? "viewer" : "editor";
}

function tokenSpaceAccess(permission: TokenPermission): SpaceRole {
  return permission === "view" ? "viewer" : permission === "edit" ? "editor" : "admin";
}

/** Caps an access result at what the token's permission allows (view < edit < admin). */
function capAccess(access: AccessResult, permission: TokenPermission): AccessResult {
  const cap = tokenSpaceAccess(permission);
  return rankMap[access] <= rankMap[cap] ? access : cap;
}

function capSpaceRole(role: SpaceRole, permission: TokenPermission): SpaceRole {
  const cap = tokenSpaceAccess(permission);
  return rankMap[role] <= rankMap[cap] ? role : cap;
}
