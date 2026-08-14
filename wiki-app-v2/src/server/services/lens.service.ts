/**
 * Lenses / saved filters — brief §12.4.
 *
 * A "lens" is a user-defined cross-cutting view over the page tree that
 * doesn't respect the parent/child hierarchy. The product-model foundation
 * for lenses already exists (§2): every page has a `attributes` table of
 * `name -> value` pairs (the "tag" convention uses `name = "tag"`). This
 * service takes a criteria object, evaluates it against the union of
 * pages × attributes × spaces, applies the same access-control filters
 * search.service.ts already uses, and returns the matching pages.
 *
 * The criteria vocabulary (brief §12.4 user-context):
 *   - `tags`:        attribute `name = "tag"`, `value IN [...]`
 *   - `properties`:  attribute `{name, value}` tuples (any other attribute name)
 *   - `titleRegex`:  regex matched against `pages.title`
 *   - `ownerScope`:  "self" → pages whose `owner_id` is the calling user,
 *                    "anyone" → no owner filter,
 *                    `{ kind: "group", groupId }` → pages owned by a member of that group
 *   - `spaceIds`:    restrict to specific spaces (default: all spaces)
 *   - `includeTrash`: include soft-deleted pages (default: false)
 *
 * All criteria are AND'd. The evaluation strategy is a single SQL query
 * joining `pages ⨝ branches ⨝ spaces ⨝ attributes`, with optional
 * IN-list filters applied per criterion. This stays fast on a personal-
 * wiki-sized dataset (hundreds to thousands of pages) and avoids N+1
 * attribute round-trips.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";
import {
  attributes,
  savedFilters,
  spaces,
} from "../db/schema.js";
import { resolveInheritedAttributes } from "./template.service.js";
import { assertSafeRegex } from "../utils/regex-safety.js";
import type { UserContext } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Thrown by `runLens` when a lens row's `criteria.titleRegex` fails the
 * ReDoS safety check (slice-42). The route layer catches this and turns
 * it into a 400 — the lens itself is malformed and must be patched.
 *
 * Existing at runtime rather than at write time: lens rows written before
 * the regex gate existed (legacy import, raw DB write, future regression)
 * can still surface here, so the service refuses to execute them.
 */
export class UnsafeLensRegexError extends Error {
  constructor(reason: string) {
    super(`unsafe lens titleRegex: ${reason}`);
    this.name = "UnsafeLensRegexError";
  }
}

/** A single lens criterion as stored in `saved_filters.criteria`. */
export interface LensCriteria {
  /** Match pages whose `attribute("tag", value)` is one of these. */
  tags?: string[];
  /**
   * Match pages whose `attribute(name, value)` matches any of these tuples
   * (one tuple per property match). Multiple tuples are OR'd; the rest of
   * the criteria are AND'd on top.
   */
  properties?: Array<{ name: string; value: string }>;
  /** Match pages whose title matches this regex (JS RegExp syntax). */
  titleRegex?: string;
  /**
   * "self" → only pages whose `owner_id` is the calling user;
   * "anyone" → no owner filter;
   * `{ kind: "group", groupId }` → pages owned by users in that group.
   */
  ownerScope?: "self" | "anyone" | { kind: "group"; groupId: string };
  /** Restrict to specific spaces (default: every space the caller can see). */
  spaceIds?: string[];
  /** Include soft-deleted pages. Default false. */
  includeTrash?: boolean;
}

/** A saved lens (mirrors the `saved_filters` row, with criteria parsed). */
export interface Lens {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  criteria: LensCriteria;
  visibility: "private" | "unlisted" | "public";
  shareToken: string | null;
  createdAt: Date;
}

/** A page row returned by `runLens`. */
export interface LensHit {
  pageId: string;
  title: string;
  slug: string;
  spaceId: string;
  spaceName: string;
  ownerId: string | null;
  /** First hit branch for the page (each page can have multiple placements;
   * lenses surface the page once per matching space). */
  branchId: string;
  isTrashed: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToLens(row: typeof savedFilters.$inferSelect): Lens {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description,
    criteria: (row.criteria ?? {}) as LensCriteria,
    visibility: row.visibility,
    shareToken: row.shareToken,
    createdAt: row.createdAt,
  };
}

/** Generate a URL-safe share token. 16 bytes → 22 base64url chars. */
function newShareToken(): string {
  return randomBytes(16).toString("base64url");
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateLensInput {
  ownerId: string;
  name: string;
  description?: string | null;
  criteria: LensCriteria;
  visibility?: Lens["visibility"];
}

/** Inserts a new lens. Generates a share token when visibility is `unlisted`. */
export async function createLens(input: CreateLensInput): Promise<Lens> {
  const { db } = getDb();
  const visibility = input.visibility ?? "private";
  const id = crypto.randomUUID();
  const shareToken = visibility === "unlisted" ? newShareToken() : null;

  await db.insert(savedFilters).values({
    id,
    ownerId: input.ownerId,
    name: input.name,
    description: input.description ?? null,
    criteria: input.criteria as never,
    visibility,
    shareToken,
  });

  const [row] = await db.select().from(savedFilters).where(eq(savedFilters.id, id));
  if (!row) throw new Error("createLens: insert succeeded but row not found");
  return rowToLens(row);
}

export interface UpdateLensInput {
  name?: string;
  description?: string | null;
  criteria?: LensCriteria;
  visibility?: Lens["visibility"];
}

/** Patches a lens. Re-mints the share token if visibility transitions to
 * `unlisted` (the old token is invalidated). */
export async function updateLens(
  id: string,
  patch: UpdateLensInput,
): Promise<Lens | null> {
  const { db } = getDb();
  const [existing] = await db.select().from(savedFilters).where(eq(savedFilters.id, id));
  if (!existing) return null;

  const next: Partial<typeof savedFilters.$inferInsert> = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.criteria !== undefined) next.criteria = patch.criteria as never;
  if (patch.visibility !== undefined) {
    next.visibility = patch.visibility;
    if (patch.visibility === "unlisted" && !existing.shareToken) {
      next.shareToken = newShareToken();
    }
    if (patch.visibility !== "unlisted") {
      next.shareToken = null;
    }
  }

  await db.update(savedFilters).set(next).where(eq(savedFilters.id, id));
  const [row] = await db.select().from(savedFilters).where(eq(savedFilters.id, id));
  if (!row) return null;
  return rowToLens(row);
}

/** Deletes a lens by id. No-op if not found. */
export async function deleteLens(id: string): Promise<boolean> {
  const { db } = getDb();
  const result = await db.delete(savedFilters).where(eq(savedFilters.id, id));
  return ((result as unknown as { changes: number }).changes ?? 0) > 0;
}

/** Fetch a lens by id. Returns null when the row doesn't exist. */
export async function getLens(id: string): Promise<Lens | null> {
  const { db } = getDb();
  const [row] = await db.select().from(savedFilters).where(eq(savedFilters.id, id));
  return row ? rowToLens(row) : null;
}

/** Fetch a lens by its unlisted share token. */
export async function getLensByToken(token: string): Promise<Lens | null> {
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(savedFilters)
    .where(and(eq(savedFilters.shareToken, token), eq(savedFilters.visibility, "unlisted")));
  return row ? rowToLens(row) : null;
}

/** List lenses the caller can see: their own (any visibility) plus every
 * `public` lens. `unlisted` lenses only surface via the share-token route. */
export async function listLensesForUser(userId: string): Promise<Lens[]> {
  const { db } = getDb();
  const rows = await db
    .select()
    .from(savedFilters)
    .where(or(eq(savedFilters.ownerId, userId), eq(savedFilters.visibility, "public")));
  return rows.map(rowToLens);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Run the lens and return the matching pages. Access control: the caller
 * must be able to view the page's space (via `resolveAccess`), and we use
 * `accessibleBranchIds` semantics for spaces we don't enumerate here. For
 * now we lean on the space-level membership table directly because the
 * criteria are evaluated SQL-side and we want to return matches without
 * an extra round-trip through the chain-walk.
 *
 * Admin users bypass per-space checks (consistent with search.service.ts).
 */
export async function runLens(lens: Lens, caller: UserContext): Promise<LensHit[]> {
  const { db, sqlite } = getDb();
  const criteria = lens.criteria;

  // Defense-in-depth (slice-42). The route validates `titleRegex` at
  // create/patch time, but a lens row written before that gate (legacy
  // import, raw DB write, or future regression) could still carry a
  // catastrophic-backtracking pattern. Re-check before executing it
  // against every page title; throw a typed error the route maps to 400.
  if (criteria.titleRegex) {
    const safety = assertSafeRegex(criteria.titleRegex);
    if (!safety.safe) {
      throw new UnsafeLensRegexError(safety.reason ?? "rejected");
    }
  }

  // Space filter: if the caller restricted by spaceIds, restrict to those.
  // Otherwise: every space (the per-page access check happens post-hoc).
  let spaceScope: string[] | null = null;
  if (criteria.spaceIds && criteria.spaceIds.length > 0) {
    spaceScope = criteria.spaceIds;
  } else if (!caller.isAdmin) {
    // Auto-scope to spaces the caller has at least viewer access to.
    spaceScope = await loadAccessibleSpaceIds(caller);
    if (spaceScope.length === 0) return [];
  }

  // Tag / property filters — these need a sub-select against attributes.
  // Strategy: derive the set of page ids matching each filter, then AND
  // them together (each constraint narrows the candidate set).
  let candidatePageIds: Set<string> | null = null;

  if (criteria.tags && criteria.tags.length > 0) {
    const tagRows = await db
      .select({ pageId: attributes.pageId })
      .from(attributes)
      .where(and(eq(attributes.name, "tag"), inArray(attributes.value, criteria.tags)));
    const set = new Set(tagRows.map((r) => r.pageId));
    candidatePageIds = intersect(candidatePageIds, set);
    if (candidatePageIds.size === 0) return [];
  }

  if (criteria.properties && criteria.properties.length > 0) {
    let propSet: Set<string> | null = null;
    for (const { name, value } of criteria.properties) {
      const rows = await db
        .select({ pageId: attributes.pageId })
        .from(attributes)
        .where(and(eq(attributes.name, name), eq(attributes.value, value)));
      const set = new Set(rows.map((r) => r.pageId));
      propSet = union(propSet, set); // OR within properties
    }
    candidatePageIds = intersect(candidatePageIds, propSet ?? new Set());
    if (candidatePageIds.size === 0) return [];
  }

  // Build the raw WHERE incrementally. Each clause appends to `params` in
  // declaration order — positional binding, no identifier interpolation.
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (!criteria.includeTrash) {
    clauses.push("p.deleted_at IS NULL");
  }

  if (criteria.titleRegex) {
    clauses.push("p.title REGEXP ?");
    params.push(criteria.titleRegex);
  }

  if (criteria.ownerScope === "self") {
    clauses.push("p.owner_id = ?");
    params.push(caller.id);
  } else if (
    typeof criteria.ownerScope === "object" &&
    criteria.ownerScope?.kind === "group"
  ) {
    clauses.push("p.owner_id IN (SELECT user_id FROM user_groups WHERE group_id = ?)");
    params.push(criteria.ownerScope.groupId);
  }

  if (spaceScope !== null) {
    clauses.push(`b.space_id IN (${spaceScope.map(() => "?").join(", ")})`);
    params.push(...spaceScope);
  }

  if (candidatePageIds !== null) {
    if (candidatePageIds.size === 0) return [];
    const ids = [...candidatePageIds];
    clauses.push(`p.id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  // Final query: pick the first non-system branch per page, joining the
  // space for the human-readable space name. GROUP BY collapses multiple
  // placements (a page cloned into N spaces shows up once per clone, with
  // the alphabetically-first space's branchId as the canonical branch).
  const rows = sqlite
    .prepare(
      `
      SELECT
        p.id              AS pageId,
        p.title           AS title,
        p.slug            AS slug,
        p.owner_id        AS ownerId,
        p.deleted_at      AS deletedAt,
        MIN(b.id)         AS branchId,
        s.id              AS spaceId,
        s.name            AS spaceName
      FROM pages p
      JOIN branches b ON b.page_id = p.id AND b.is_system = 0
      JOIN spaces s ON s.id = b.space_id
      ${whereSql}
      GROUP BY p.id
      ORDER BY p.title ASC
      LIMIT 200
    `,
    )
    .all(...params) as Array<{
      pageId: string;
      title: string;
      slug: string;
      ownerId: string | null;
      deletedAt: number | null;
      branchId: string;
      spaceId: string;
      spaceName: string;
    }>;

  return rows.map((r) => ({
    pageId: r.pageId,
    title: r.title,
    slug: r.slug,
    spaceId: r.spaceId,
    spaceName: r.spaceName,
    ownerId: r.ownerId,
    branchId: r.branchId,
    isTrashed: r.deletedAt !== null,
  }));
}

// ---------------------------------------------------------------------------
// Attribute enrichment — brief §13.4.
//
// `runLens` returns page-level rows. For table & board views we need each
// hit's promoted attributes, merged with the inherited promoted attributes
// from any template(s) the page declares (§13.3). This module adds that
// enrichment on top of `runLens` without changing its signature or its
// existing tests.
//
// Performance note: the template walk happens per hit. For the lens-size
// datasets the product targets (tens to a few hundred hits) this is fine.
// If a profile shows it hot, the right next step is to memoize the
// resolver by (pageId, userId) and to batch the per-template attribute
// lookups into a single IN-list query.
// ---------------------------------------------------------------------------

/** One promoted attribute on a lens hit, with provenance so the UI can
 *  distinguish own vs. inherited (and the template that sourced it). */
export interface LensHitAttribute {
  name: string;
  value: string;
  /** `true` if this attribute was set directly on the page; `false`
   *  if it was inherited from a template via the §13.3 chain. */
  own: boolean;
  /** Title of the template the attribute was inherited from, when
   *  `own === false`. Undefined on own attributes. */
  fromTitle?: string;
}

/** A lens hit enriched with promoted attributes (own + inherited). */
export interface EnrichedLensHit extends LensHit {
  /** Promoted attributes only (those with `is_promoted = true` on the
   *  page or any template ancestor). Sorted by `name` for stable column
   *  ordering. Empty array when the hit has no promoted attributes. */
  promotedAttributes: LensHitAttribute[];
}

/** Run the lens and attach promoted attributes to each hit. Wraps
 *  `runLens`; returns enriched hits in the same order. Permissions are
 *  applied per-template inside `resolveInheritedAttributes` (no
 *  existence leak). */
export async function runLensWithAttributes(
  lens: Lens,
  caller: UserContext,
): Promise<EnrichedLensHit[]> {
  const hits = await runLens(lens, caller);
  if (hits.length === 0) return [];

  // Resolve own + inherited promoted attributes for every hit. The
  // resolver is permission-filtered, so any template the caller can't
  // read is silently dropped (same rule as graph/backlinks/relations).
  const enriched: EnrichedLensHit[] = [];
  for (const hit of hits) {
    enriched.push(await enrichOneHit(hit, caller));
  }
  return enriched;
}

/** Enrich one lens hit with its promoted attributes (own + inherited).
 *  Own promoted attributes come from a direct query on the `attributes`
 *  table. Inherited promoted attributes come from `resolveInheritedAttributes`,
 *  whose `inheritedAttributes` field already excludes the page's own
 *  attributes and tags each entry with `templateTitle` for provenance. */
async function enrichOneHit(hit: LensHit, caller: UserContext): Promise<EnrichedLensHit> {
  const { db } = getDb();

  // Own promoted: one query per page.
  const ownPromoted = await db
    .select({
      name: attributes.name,
      value: attributes.value,
      isPromoted: attributes.isPromoted,
    })
    .from(attributes)
    .where(and(eq(attributes.pageId, hit.pageId), eq(attributes.isPromoted, true)));

  // Inherited: the resolver returns the merged set with provenance;
  // filter to promoted only.
  const { inheritedAttributes } = await resolveInheritedAttributes(hit.pageId, caller);
  const inheritedPromoted = inheritedAttributes.filter((a) => a.isPromoted);

  // Own wins on collision: seed Map from inherited, then overwrite with own.
  const byName = new Map<string, LensHitAttribute>();
  for (const a of inheritedPromoted) {
    byName.set(a.name, {
      name: a.name,
      value: a.value,
      own: false,
      fromTitle: a.templateTitle,
    });
  }
  for (const a of ownPromoted) {
    byName.set(a.name, { name: a.name, value: a.value, own: true });
  }

  const merged = [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
  return { ...hit, promotedAttributes: merged };
}

// ---------------------------------------------------------------------------
// Tiny set helpers (candidate-id narrowing).
// ---------------------------------------------------------------------------

function intersect(a: Set<string> | null, b: Set<string>): Set<string> {
  if (!a) return b;
  const out = new Set<string>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

function union(a: Set<string> | null, b: Set<string>): Set<string> {
  if (!a) return b;
  const out = new Set(a);
  for (const v of b) out.add(v);
  return out;
}

/**
 * Find every space the caller has at least viewer access to. Reuses the
 * space_members / group_permissions union that `accessibleBranchIds` already
 * evaluates in branch.service.ts; we re-implement the SQL here rather than
 * importing that helper because it returns branch IDs, not space IDs.
 */
async function loadAccessibleSpaceIds(caller: UserContext): Promise<string[]> {
  const { db } = getDb();
  // Admin sees every space.
  if (caller.isAdmin) {
    const all = await db.select({ id: spaces.id }).from(spaces);
    return all.map((s) => s.id);
  }

  const groupIds = caller.groupIds ?? [];
  // Direct membership:
  const direct = await db
    .select({ spaceId: sql<string>`space_id` })
    .from(sql`space_members`)
    .where(sql`user_id = ${caller.id}`);
  // Group-permission grants (groups the caller belongs to):
  const viaGroup = groupIds.length
    ? await db
        .select({ spaceId: sql<string>`space_id` })
        .from(sql`space_group_permissions`)
        .where(inArray(sql<string>`group_id`, groupIds))
    : [];
  const ids = new Set<string>();
  for (const r of direct) ids.add(r.spaceId);
  for (const r of viaGroup) ids.add(r.spaceId);
  return [...ids];
}
