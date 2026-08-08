import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { getAuth } from "../auth/config.js";
import { resolveUserCapabilities, resolveUserGroupIds } from "./capabilities.service.js";
import type { UserContext } from "../../shared/types.js";

/**
 * Resolves the current request's user via better-auth's own session validation
 * (auth.api.getSession) rather than hand-querying the session/user tables
 * directly. Hand-querying would mean re-implementing token-format and
 * expiry-check logic that better-auth already owns correctly - exactly the kind
 * of subtle auth bug this project has been careful to avoid elsewhere.
 */
export async function getUserContext(headers: Headers): Promise<UserContext | null> {
  const result = await getAuth().api.getSession({ headers });
  if (!result) return null;

  const groupIds = await resolveUserGroupIds(result.user.id);
  const isAdmin = (result.user as unknown as { isAdmin?: boolean }).isAdmin ?? false;

  return {
    id: result.user.id,
    isAdmin,
    groupIds,
    capabilities: await resolveUserCapabilities(result.user.id),
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
  const { db } = getDb();
  const [userRow] = await db.select().from(users).where(eq(users.id, userId));
  if (!userRow) throw new Error(`user ${userId} not found`);

  const groupIds = await resolveUserGroupIds(userId);

  return {
    id: userRow.id,
    isAdmin: userRow.isAdmin ?? false,
    groupIds,
    capabilities: await resolveUserCapabilities(userId),
    spaceRoles: {},
  };
}
