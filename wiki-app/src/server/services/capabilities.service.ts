import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { userGroups, groups } from "../db/schema.js";

/**
 * Group memberships + the union of their capabilities for a user. Kept in its
 * own module (no import of the better-auth config) so both `auth.service.ts`
 * and the better-auth session-enrichment plugin can use it without creating a
 * circular import.
 */
export async function resolveUserGroupIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId));
  return rows.map((r) => r.groupId);
}

/**
 * Union of capabilities from all groups the user belongs to. Admins implicitly
 * get everything via `admin.*` handling in permissions, so no special-casing
 * needed here.
 */
export async function resolveUserCapabilities(userId: string): Promise<string[]> {
  const groupIds = await resolveUserGroupIds(userId);
  if (groupIds.length === 0) return [];
  const groupRows = await db
    .select({ capabilities: groups.capabilities })
    .from(groups)
    .where(sql`${groups.id} IN ${groupIds}`);
  const caps = new Set<string>();
  for (const g of groupRows) {
    if (Array.isArray(g.capabilities)) {
      for (const c of g.capabilities) caps.add(c);
    }
  }
  return [...caps];
}
