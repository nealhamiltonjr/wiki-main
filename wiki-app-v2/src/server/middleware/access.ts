import type { FastifyInstance } from "fastify";
import type { AccessResult, SpaceRole } from "../../shared/types.js";

/**
 * Every /api/ route MUST declare its access requirement via `config.access`
 * at registration time — there is no way to register one without it (the
 * onRoute check below fails the server boot). This is the direct structural
 * fix for the finding in brief §3.18: the permission algorithm was written
 * correctly but never actually invoked from any route. Declarative and
 * hook-driven means a forgotten check fails at startup, not silently at
 * request time.
 *
 * Slice 2 installs the declaration invariant and the boot refusal; the full
 * preHandler enforcement (resolveAccess against branch chains / space roles,
 * token + share-link handling) lands in slice 4 with the tree services.
 */
export type RouteAccess =
  | "public" // no auth required at all
  | "authenticated" // any logged-in user, no specific branch/role check
  | "admin" // global admin only
  | { branchParam: string; minRole: Exclude<AccessResult, "none">; source?: "params" | "query" | "body"; allowShareToken?: true }
  | { spaceParam: string; minRole: SpaceRole; source?: "params" | "query" | "body" };

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

export function registerAccessDeclarationCheck(app: FastifyInstance) {
  // Validated at REGISTRATION time, not guessed at request time: any /api/
  // route (other than /api/auth/*, which establishes identity rather than
  // requiring it) must declare `config.access`, or the server refuses to
  // start.
  app.addHook("onRoute", (routeOptions) => {
    const url = typeof routeOptions.url === "string" ? routeOptions.url : "";
    if (!url.startsWith("/api/") || url.startsWith("/api/auth/")) return;
    if (!routeOptions.config?.access) {
      throw new Error(
        `Route ${JSON.stringify(routeOptions.method)} ${url} does not declare config.access - every /api/ route must (see middleware/access.ts)`
      );
    }
  });
}
