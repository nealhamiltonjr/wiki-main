import { sql, eq, and, isNull, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { branches, pages, groups, groupPermissions, spaceMembers, spaceGroupPermissions, attributes } from "../db/schema.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { BranchContext, BranchRole, SpaceRole, UserContext } from "../../shared/types.js";

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

/**
 * Batch version of resolveAccess(null, chain, null): returns the set of branch
 * ids an anonymous visitor can actually read, for public mode + restricted
 * sub-tree filtering. A branch is anonymous-visible iff (a) no system branch in
 * its chain, (b) the nearest explicit visibility in the chain is "public", and
 * (c) NO branch in the chain carries an explicit group-permission boundary
 * (the local-boundary hard stop denies non-members outright). Computed in one
 * query per space instead of one recursive-CTE walk per branch.
 */
export async function anonymousVisibleBranchIds(spaceId?: string): Promise<Set<string>> {
  const rows = spaceId
    ? await db.select().from(branches).where(eq(branches.spaceId, spaceId))
    : await db.select().from(branches);
  if (rows.length === 0) return new Set();

  const byId = new Map(rows.map((r) => [r.id, r]));
  const boundaryRows = await db
    .select({ branchId: groupPermissions.branchId })
    .from(groupPermissions)
    .where(inArray(groupPermissions.branchId, rows.map((r) => r.id)));
  const hasBoundary = new Set(boundaryRows.map((r) => r.branchId));

  const visible = new Set<string>();
  for (const r of rows) {
    if (r.isSystem) continue;
    let visibility: "inherit" | "public" | "private" = "inherit";
    let boundary = false;
    let cur: (typeof r) | undefined = r;
    let depth = 0;
    while (cur) {
      if (hasBoundary.has(cur.id)) { boundary = true; break; }
      if (visibility === "inherit" && cur.visibility !== "inherit") visibility = cur.visibility;
      cur = cur.parentBranchId ? byId.get(cur.parentBranchId) : undefined;
      if (++depth > 200) break; // cycle guard
    }
    if (boundary) continue;
    if (visibility === "inherit") visibility = "private";
    if (visibility === "public") visible.add(r.id);
  }
  return visible;
}

/**
 * Batch per-node access resolution for a whole space: returns the set of branch
 * ids the user can actually read (resolveAccess != "none"). Used by the tree
 * route to prune restricted descendants from the listing (§7.12g). Same data
 * as getBranchChain but computed for all branches in one query.
 */
export async function accessibleBranchIds(
  user: UserContext,
  spaceId: string,
  spaceRole: SpaceRole | null
): Promise<Set<string>> {
  const rows = await db.select().from(branches).where(eq(branches.spaceId, spaceId));
  if (rows.length === 0) return new Set();

  const byId = new Map(rows.map((r) => [r.id, r]));
  const permRows = await db
    .select({ branchId: groupPermissions.branchId, groupId: groupPermissions.groupId, role: groupPermissions.role })
    .from(groupPermissions)
    .where(inArray(groupPermissions.branchId, rows.map((r) => r.id)));
  const permsByBranch = new Map<string, Record<string, BranchRole>>();
  for (const p of permRows) {
    const m = permsByBranch.get(p.branchId) ?? {};
    m[p.groupId] = p.role;
    permsByBranch.set(p.branchId, m);
  }

  const accessible = new Set<string>();
  for (const r of rows) {
    const chain: BranchContext[] = [];
    let cur: (typeof r) | undefined = r;
    let depth = 0;
    while (cur) {
      chain.push({
        id: cur.id,
        spaceId: cur.spaceId,
        visibility: cur.visibility,
        isSystem: cur.isSystem,
        parentBranchId: cur.parentBranchId,
        branchGroupPermissions: permsByBranch.get(cur.id) ?? {},
      });
      cur = cur.parentBranchId ? byId.get(cur.parentBranchId) : undefined;
      if (++depth > 200) break; // cycle guard
    }
    if (resolveAccess(user, chain, spaceRole) !== "none") accessible.add(r.id);
  }
  return accessible;
}

export interface SpaceTreeNode {
  id: string;
  pageId: string;
  slug: string;
  /** UI overhaul B3: the page's `icon` attribute (emoji), if set. */
  icon?: string | null;
  children: SpaceTreeNode[];
}

/**
 * Builds the space tree (system branches and deleted pages excluded) with
 * per-node access pruning applied for the caller (§7.12g restricted-ancestor
 * integration). Shared by the branch- and space-scoped tree endpoints so the
 * two can never drift apart. A branch-scoped token sees only its own branch.
 */
export async function buildSpaceTree(
  spaceId: string,
  opts: {
    user?: UserContext | null;
    spaceRole?: SpaceRole | null;
    branchTokenScopeId?: string | null;
  } = {}
): Promise<SpaceTreeNode[]> {
  const rows = await db
    .select({
      branchId: branches.id,
      pageId: branches.pageId,
      parentId: branches.parentBranchId,
      slug: pages.slug,
    })
    .from(branches)
    .innerJoin(pages, eq(branches.pageId, pages.id))
    .where(and(eq(branches.spaceId, spaceId), eq(branches.isSystem, false), isNull(pages.deletedAt)));

  if (opts.branchTokenScopeId) {
    const hit = rows.find((r) => r.branchId === opts.branchTokenScopeId);
    return hit
      ? [{ id: hit.branchId, pageId: hit.pageId, slug: hit.slug, children: [] }]
      : [];
  }

  const visible = opts.user
    ? await accessibleBranchIds(opts.user, spaceId, opts.spaceRole ?? null)
    : new Set(rows.map((r) => r.branchId));

  const map = new Map<string, SpaceTreeNode>();
  const roots: SpaceTreeNode[] = [];
  for (const r of rows) {
    if (!visible.has(r.branchId)) continue;
    map.set(r.branchId, { id: r.branchId, pageId: r.pageId, slug: r.slug, children: [] });
  }

  // UI overhaul B3: attach each page's `icon` attribute (emoji) so the tree can
  // render it next to the slug. One indexed query for the whole space.
  if (map.size > 0) {
    const iconRows = await db
      .select({ pageId: attributes.pageId, value: attributes.value })
      .from(attributes)
      .where(
        and(
          inArray(attributes.pageId, [...map.values()].map((n) => n.pageId)),
          eq(attributes.name, "icon")
        )
      );
    const iconByPage = new Map(iconRows.map((r) => [r.pageId, r.value]));
    for (const node of map.values()) {
      const icon = iconByPage.get(node.pageId);
      if (icon) node.icon = icon;
    }
  }

  for (const r of rows) {
    const node = map.get(r.branchId);
    if (!node) continue;
    if (r.parentId && map.has(r.parentId)) map.get(r.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Lists a branch's explicit group grants, with group names for the UI. */
export async function listBranchPermissions(branchId: string) {
  return db
    .select({ groupId: groups.id, groupName: groups.name, role: groupPermissions.role })
    .from(groupPermissions)
    .innerJoin(groups, eq(groups.id, groupPermissions.groupId))
    .where(eq(groupPermissions.branchId, branchId));
}

/**
 * Replaces the branch's explicit group grants wholesale. Caller (route) has
 * already asserted editor access on the branch; this is a pure write.
 */
export async function setBranchPermissions(
  branchId: string,
  grants: { groupId: string; role: BranchRole }[]
): Promise<void> {
  await db.delete(groupPermissions).where(eq(groupPermissions.branchId, branchId));
  for (const g of grants) {
    await db.insert(groupPermissions).values({ branchId, groupId: g.groupId, role: g.role });
  }
}

/** Removes a single group grant from a branch. Idempotent - missing grant is a no-op. */
export async function removeBranchPermission(branchId: string, groupId: string): Promise<void> {
  await db
    .delete(groupPermissions)
    .where(and(eq(groupPermissions.branchId, branchId), eq(groupPermissions.groupId, groupId)));
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
