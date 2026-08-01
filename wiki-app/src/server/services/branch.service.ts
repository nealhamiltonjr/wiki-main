import { sql, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { branches, groupPermissions, spaceMembers, spaceGroupPermissions } from "../db/schema.js";
import type { BranchContext, SpaceRole } from "../../shared/types.js";

/**
 * Returns the target branch and its ancestors, NEAREST FIRST (target at index 0,
 * space root last) - the exact shape resolveAccess() expects. A single recursive
 * CTE anchored on the target id, walking parent_branch_id upward.
 */
export async function getBranchChain(branchId: string): Promise<BranchContext[]> {
  const rows = db.all<{
    id: string; space_id: string; visibility: "inherit" | "public" | "private";
    is_system: number; parent_branch_id: string | null; depth: number;
  }>(sql`
    WITH RECURSIVE chain(id, space_id, visibility, is_system, parent_branch_id, depth) AS (
      SELECT id, space_id, visibility, is_system, parent_branch_id, 0
      FROM branches WHERE id = ${branchId}
      UNION ALL
      SELECT b.id, b.space_id, b.visibility, b.is_system, b.parent_branch_id, c.depth + 1
      FROM branches b JOIN chain c ON b.id = c.parent_branch_id
    )
    SELECT * FROM chain ORDER BY depth ASC
  `);

  if (rows.length === 0) {
    throw new Error(`getBranchChain: branch ${branchId} not found`);
  }

  const chain: BranchContext[] = rows.map((r) => ({
    id: r.id,
    spaceId: r.space_id,
    visibility: r.visibility,
    isSystem: !!r.is_system,
    parentBranchId: r.parent_branch_id,
    branchGroupPermissions: {},
  }));

  await populateBranchPermissions(chain);
  return chain;
}

/** Mutates each BranchContext in place, attaching its explicit group_permissions (if any). */
export async function populateBranchPermissions(chain: BranchContext[]): Promise<void> {
  if (chain.length === 0) return;
  const rows = await db
    .select({ branchId: groupPermissions.branchId, groupId: groupPermissions.groupId, role: groupPermissions.role })
    .from(groupPermissions)
    .where(inArray(groupPermissions.branchId, chain.map((b) => b.id)));

  const byBranch = new Map(chain.map((b) => [b.id, b]));
  for (const row of rows) {
    const branch = byBranch.get(row.branchId);
    if (branch) branch.branchGroupPermissions[row.groupId] = row.role;
  }
}

/**
 * Resolves a user's effective role for a space: the best of their direct
 * space_members role and any role granted via space_group_permissions to a
 * group they belong to. Returns null if the user has no role in the space at all.
 */
export async function resolveSpaceRole(
  userId: string,
  spaceId: string,
  userGroupIds: string[]
): Promise<SpaceRole | null> {
  const rank: Record<SpaceRole, number> = { viewer: 1, editor: 2, admin: 3 };
  let best: SpaceRole | null = null;

  const [directRole] = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(sql`${spaceMembers.spaceId} = ${spaceId} AND ${spaceMembers.userId} = ${userId}`);
  if (directRole) best = directRole.role;

  if (userGroupIds.length > 0) {
    const groupRoles = await db
      .select({ role: spaceGroupPermissions.role })
      .from(spaceGroupPermissions)
      .where(
        sql`${spaceGroupPermissions.spaceId} = ${spaceId} AND ${spaceGroupPermissions.groupId} IN ${userGroupIds}`
      );
    for (const gr of groupRoles) {
      if (!best || rank[gr.role] > rank[best]) best = gr.role;
    }
  }

  return best;
}
