import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tokens, userGroups, groups } from "../db/schema.js";
import type { TokenType, TokenScopeType } from "../../shared/types.js";

function generateRawToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * "No expiration" is a deliberate, permissioned action (brief §3.10) - gated by
 * membership in a "link-managers" group (or global admin), distinct from admin.
 * This is a simplified stand-in for the fuller capability system the brief
 * describes (a generic `create_permanent_links` capability on any group) -
 * hardcoded to one specific group name for now since the general capability
 * table doesn't exist yet. Documented here rather than silently narrowed.
 */
async function canGrantNoExpiration(userId: string, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  const { db } = getDb();
  const [row] = await db
    .select({ id: groups.id })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(and(eq(userGroups.userId, userId), eq(groups.name, "link-managers")));
  return !!row;
}

export async function createShareLink(opts: {
  branchOrSpaceId: string;
  scopeType: Extract<TokenScopeType, "branch" | "space">;
  createdBy: string;
  isAdmin: boolean;
  permission: "view" | "edit";
  expiresAt: Date | null; // null = no expiration - only allowed if capability check passes
  password?: string;
  name?: string;
}): Promise<{ id: string; rawToken: string }> {
  if (opts.expiresAt === null && !(await canGrantNoExpiration(opts.createdBy, opts.isAdmin))) {
    throw new Error("NO_EXPIRATION_NOT_PERMITTED");
  }

  const raw = generateRawToken("whk");
  const id = crypto.randomUUID();

  const { db } = getDb();
  await db.insert(tokens).values({
    id,
    type: "share_link",
    tokenHash: hashToken(raw),
    createdBy: opts.createdBy,
    name: opts.name ?? null,
    scopeType: opts.scopeType,
    scopeId: opts.branchOrSpaceId,
    permission: opts.permission,
    passwordHash: opts.password ? hashToken(opts.password) : null,
    expiresAt: opts.expiresAt,
    warningCount: 0,
  });

  return { id, rawToken: raw };
}

export async function createApiToken(opts: {
  createdBy: string;
  isAdmin: boolean;
  scopeType: TokenScopeType;
  scopeId: string | null; // null only valid when scopeType === 'account'
  permission: "view" | "edit" | "admin";
  expiresAt: Date | null;
  name?: string;
}): Promise<{ id: string; rawToken: string }> {
  if (opts.scopeType === "account" && opts.scopeId !== null) {
    throw new Error("ACCOUNT_SCOPE_MUST_HAVE_NULL_SCOPE_ID");
  }
  if (opts.expiresAt === null && !(await canGrantNoExpiration(opts.createdBy, opts.isAdmin))) {
    throw new Error("NO_EXPIRATION_NOT_PERMITTED");
  }

  const raw = generateRawToken("wak");
  const id = crypto.randomUUID();

  const { db } = getDb();
  await db.insert(tokens).values({
    id,
    type: "api_token",
    tokenHash: hashToken(raw),
    createdBy: opts.createdBy,
    name: opts.name ?? null,
    scopeType: opts.scopeType,
    scopeId: opts.scopeId,
    permission: opts.permission,
    expiresAt: opts.expiresAt,
    warningCount: 0,
  });

  return { id, rawToken: raw };
}

export interface ResolvedToken {
  id: string;
  type: TokenType;
  createdBy: string;
  scopeType: TokenScopeType;
  scopeId: string | null;
  permission: "view" | "edit" | "admin";
  passwordHash: string | null;
}

/** Looks up a raw token, checks expiry/revocation, and touches last-accessed + resets the watchdog counter. */
export async function resolveToken(rawToken: string): Promise<ResolvedToken | null> {
  const { db } = getDb();
  const hash = hashToken(rawToken);
  const [row] = await db.select().from(tokens).where(eq(tokens.tokenHash, hash));
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Any real access resets the watchdog - only inactivity should count toward
  // auto-expiry, not the mere passage of time (brief §3.10).
  await db
    .update(tokens)
    .set({ lastAccessedAt: new Date(), warningCount: 0 })
    .where(eq(tokens.id, row.id));

  return {
    id: row.id,
    type: row.type,
    createdBy: row.createdBy,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    permission: row.permission,
    passwordHash: row.passwordHash,
  };
}

export function checkTokenPassword(token: ResolvedToken, suppliedPassword: string | undefined): boolean {
  if (!token.passwordHash) return true; // not password-protected
  if (!suppliedPassword) return false;
  return hashToken(suppliedPassword) === token.passwordHash;
}

// ---------------------------------------------------------------------------
// Watchdog (brief §3.10) - no-expiration links get warned after N days of
// inactivity, and auto-expire after 3 unheeded warnings. Run periodically from
// the worker loop, not as a one-off job-queue entry (it's a recurring sweep
// over all matching rows, not a single scheduled task).
// ---------------------------------------------------------------------------
const INACTIVITY_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days - a reasonable default, not yet exposed as a setting
const MAX_WARNINGS = 3;

export async function runShareLinkWatchdog(notify: (tokenId: string, createdBy: string, warningCount: number) => void) {
  const { db } = getDb();
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - INACTIVITY_THRESHOLD_MS);

  const candidates = await db
    .select()
    .from(tokens)
    .where(
      and(
        eq(tokens.type, "share_link"),
        isNull(tokens.expiresAt), // only no-expiration links are watched
        isNull(tokens.revokedAt)
      )
    );

  for (const t of candidates) {
    const lastActivity = t.lastAccessedAt ?? t.createdAt;
    if (lastActivity.getTime() >= staleCutoff.getTime()) continue; // still active, nothing to do

    // Don't re-warn more often than the inactivity window itself.
    if (t.lastWarningAt && t.lastWarningAt.getTime() >= staleCutoff.getTime()) continue;

    const nextWarningCount = t.warningCount + 1;
    if (nextWarningCount > MAX_WARNINGS) {
      await db.update(tokens).set({ revokedAt: now }).where(eq(tokens.id, t.id));
      notify(t.id, t.createdBy, nextWarningCount);
    } else {
      await db.update(tokens).set({ warningCount: nextWarningCount, lastWarningAt: now }).where(eq(tokens.id, t.id));
      notify(t.id, t.createdBy, nextWarningCount);
    }
  }
}
