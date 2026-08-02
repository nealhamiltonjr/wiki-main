import type { FastifyInstance } from "fastify";
import { buildSpaceTree, resolveSpaceRole } from "../services/branch.service.js";
import type { UserContext } from "../../shared/types.js";

export async function treeRoutes(app: FastifyInstance) {
  // Space-root access check: the middleware needs a branchParam, so the tree
  // endpoint is registered per-root-branch, not per-space directly - this keeps
  // the same permission machinery as every other route instead of a bespoke
  // space-level-only check that could drift from it. The tree body itself comes
  // from buildSpaceTree (shared with /api/spaces/:id/tree) so per-node pruning
  // can never drift between the two endpoints.
  app.get(
    "/api/branches/:branchId/tree",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const chain = (request as any).branchChain as { id: string; spaceId: string }[];
      const spaceId = chain[0]!.spaceId;

      const tokenScope = (request as any).tokenScope as { scopeType: string; scopeId: string } | undefined;
      const branchTokenScopeId =
        (request as any).principalKind === "token" && tokenScope?.scopeType === "branch" ? tokenScope.scopeId : null;

      const user = (request as any).userContext as UserContext;
      const spaceRole = user.isAdmin
        ? "admin" as const
        : await resolveSpaceRole(user.id, spaceId, user.groupIds);

      return reply.send(await buildSpaceTree(spaceId, { user, spaceRole, branchTokenScopeId }));
    }
  );
}
