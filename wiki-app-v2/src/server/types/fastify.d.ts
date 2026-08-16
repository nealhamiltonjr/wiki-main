import "fastify";
import type { UserContext, BranchContext, SpaceRole, AccessResult } from "../../shared/types.js";

/**
 * Phase 4.3 — Typed Fastify request augmentation.
 *
 * Eliminates the `(request as any).userContext` cast pattern. The access
 * middleware stashes these fields on the request; declaring them here
 * gives handlers type-safe access without casts.
 *
 * All fields are optional — not every route populates every field.
 */
declare module "fastify" {
  interface FastifyRequest {
    userContext?: UserContext;
    principalKind?: "session" | "share_token" | "api_token";
    tokenScope?: { scopeType: "branch" | "space" | "account"; scopeId: string | null; permission: "view" | "edit" | "admin" };
    resolvedAccess?: AccessResult;
    resolvedSpaceRole?: SpaceRole | null;
    branchChain?: BranchContext[];
  }
}
