import type { AccessResult, UserContext, BranchContext, SpaceRole } from "../types.js";

/**
 * THE single permission-resolution function for the whole app - brief v5 §3.8.
 * Every route, MCP tool, real-time collab connect/update, and file-serving path
 * must call this (via the shared middleware, see server/middleware/permissions.ts)
 * rather than re-implementing any part of it.
 *
 * `chain` is the target branch and its ancestors, NEAREST FIRST - chain[0] is the
 * branch actually being accessed, chain[chain.length - 1] is the space root.
 * This mirrors exactly what branch.service.ts's recursive CTE returns, and is
 * deliberately a single array (not a separate targetBranch + ancestors pair):
 * splitting those into two parameters was the direct cause of both bugs found in
 * the prior implementation's code review (§3.18) - a single ordered chain makes
 * "check the nearest thing first" the only way to write the walk, instead of an
 * option you can accidentally skip.
 */
export function resolveAccess(
  user: UserContext | null,
  chain: BranchContext[],
  spaceRole: SpaceRole | null
): AccessResult {
  if (chain.length === 0) {
    throw new Error("resolveAccess: chain must include at least the target branch");
  }

  // 1. System-branch guard - checked first, before anything else. Trash (and any
  //    other structural branch) must never leak through visibility or group grants.
  const touchesSystemBranch = chain.some((b) => b.isSystem);
  if (touchesSystemBranch) {
    return user?.isAdmin ? "admin" : "none";
  }

  // 2. Admin bypass.
  if (user?.isAdmin) return "admin";

  // 3. Resolve visibility, nearest-first. The target's own explicit setting always
  //    wins outright - we only continue past it when the target itself is 'inherit'.
  //    (Bug fixed here: the reviewed implementation looped over ALL ancestors and
  //    let a farther-away explicit setting overwrite a nearer one, including the
  //    target's own.)
  let resolvedVisibility = chain[0]!.visibility;
  if (resolvedVisibility === "inherit") {
    for (let i = 1; i < chain.length; i++) {
      const v = chain[i]!.visibility;
      if (v !== "inherit") {
        resolvedVisibility = v;
        break;
      }
    }
  }
  if (resolvedVisibility === "inherit") resolvedVisibility = "private"; // default if nothing ever set it

  const visibilityBaseline: AccessResult = resolvedVisibility === "public" ? "viewer" : "none";

  // 4. Local boundaries: nearest branch in the chain (starting at the target
  //    itself) with an explicit group_permissions entry FULLY REPLACES everything
  //    above it - including the visibility baseline. This is a hard stop: a match
  //    returns that role, a non-match returns 'none'. It must NOT merge with the
  //    baseline. (Bug fixed here: the reviewed implementation returned
  //    getHigherRole(branchBest, baseline), which let a public-visibility baseline
  //    leak through even when the local boundary explicitly denied the user -
  //    defeating the entire point of this step.)
  //
  //    Anonymous is governed by boundaries too: a restricted page must not leak
  //    to unauthenticated visitors via public visibility or public mode (§7.12g
  //    restricted-ancestor integration). Anonymous is never a group member, so
  //    any boundary in the chain denies them outright.
  for (const branch of chain) {
    const explicitGroupIds = Object.keys(branch.branchGroupPermissions);
    if (explicitGroupIds.length > 0) {
      if (!user) return "none";
      let best: AccessResult = "none";
      for (const groupId of user.groupIds) {
        const role = branch.branchGroupPermissions[groupId];
        if (role && rank(role) > rank(best)) best = role;
      }
      return best; // hard stop - never merged with visibilityBaseline
    }
  }

  // 5. No boundary anywhere in the chain -> anonymous reads the public baseline.
  if (!user) return visibilityBaseline;

  // 6. Authenticated: fall back to the space role, floored by the visibility
  //    baseline (an authenticated non-member of a public space still gets at
  //    least read access, same as an anonymous visitor).
  const spaceAccess: AccessResult = spaceRole ?? "none";
  return rank(spaceAccess) >= rank(visibilityBaseline) ? spaceAccess : visibilityBaseline;
}

function rank(a: AccessResult): number {
  switch (a) {
    case "none": return 0;
    case "viewer": return 1;
    case "editor": return 2;
    case "admin": return 3;
  }
}
