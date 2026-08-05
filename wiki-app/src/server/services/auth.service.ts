import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { userGroups, users, groups } from "../db/schema.js";
import { auth } from "../auth/config.js";
import type { UserContext } from "../../shared/types.js";

/**
 * Resolves the current request's user via better-auth's own session validation
 * (auth.api.getSession) rather than hand-querying the session/user tables
 * directly. Hand-querying would mean re-implementing token-format and
 * expiry-check logic that better-auth already owns correctly - exactly the kind
 * of subtle auth bug this project has been careful to avoid elsewhere.
 */
/**
 * Resolve a user's capabilities from all their groups. Returns empty for admins
 * (isAdmin implicitly grants everything, no need to enumerate).
 */
async function resolveCapabilities(userId: string, groupIds: string[]): Promise<string[]> {
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

export async function getUserContext(headers: Headers): Promise<UserContext | null> {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;

  const groupRows = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, result.user.id));
  const groupIds = groupRows.map((g) => g.groupId);
  const isAdmin = (result.user as unknown as { isAdmin?: boolean }).isAdmin ?? false;

  return {
    id: result.user.id,
    isAdmin,
    groupIds,
    capabilities: await resolveCapabilities(result.user.id, groupIds),
    spaceRoles: {},
  };
}

/**
 * Same shape as getUserContext, but resolved directly from the users table by
 * id instead of from a session. Used to establish the *creator's* identity for
 * an API-token request - the token holder acts as the token's creator, and the
 * middleware then enforces the token's own scope/permission on top of that.
 */
export async function getUserContextById(userId: string): Promise<UserContext> {
  const [userRow] = await db.select().from(users).where(eq(users.id, userId));
  if (!userRow) throw new Error(`user ${userId} not found`);

  const groupRows = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId));
  const groupIds = groupRows.map((g) => g.groupId);

  return {
    id: userRow.id,
    isAdmin: userRow.isAdmin ?? false,
    groupIds,
    capabilities: await resolveCapabilities(userId, groupIds),
    spaceRoles: {},
  };
}
