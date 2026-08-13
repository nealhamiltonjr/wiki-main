import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";
import {
  attributes,
  branches,
  pages,
  spaceGroupPermissions,
  spaceMembers,
  spaces,
} from "../db/schema.js";
import type { UserContext } from "../../shared/types.js";

/**
 * Slice-25 (§13.1 — typed relations).
 *
 * A relation is an `attributes` row whose `valuePageId` is set; the
 * relation's user-defined type is the `name` column (e.g. "depends on",
 * "supersedes", "is a component of"). The brief is explicit that
 * relations are queryable in both directions and "feed the same
 * permission checks as any other page reference — a relation to a
 * page you can't access should not leak that page's existence" — so
 * listing filters out targets (owned) and sources (incoming) the
 * caller cannot read, rather than redacting.
 */

const RELATION_TYPE_MAX = 64;
/** Allow Trilium-like relation names: any printable text up to
 *  RELATION_TYPE_MAX, no leading/trailing whitespace, no control
 *  characters. The strictest blocking rule that's still friendly to
 *  free-form names like "depends on" or "is a component of". */
const RELATION_TYPE_CONTROL = /[\u0000-\u001f\u007f]/;

export interface OwnedRelation {
  id: string;
  type: string;
  position: number;
  createdAt: Date;
  target: { id: string; title: string } | null;
}

export interface IncomingRelation {
  id: string;
  type: string;
  position: number;
  createdAt: Date;
  source: { id: string; title: string } | null;
}

export interface CreateRelationInput {
  fromPageId: string;
  type: string;
  toPageId: string;
  position?: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class RelationValidationError extends Error {}

function assertValidType(type: string): void {
  if (!type || !type.trim()) {
    throw new RelationValidationError("relation type is required");
  }
  if (type !== type.trim()) {
    throw new RelationValidationError("relation type must not have leading/trailing whitespace");
  }
  if (type.length > RELATION_TYPE_MAX) {
    throw new RelationValidationError(
      `relation type must be ≤ ${RELATION_TYPE_MAX} characters`,
    );
  }
  if (RELATION_TYPE_CONTROL.test(type)) {
    throw new RelationValidationError("relation type must not contain control characters");
  }
}

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

/** True when the caller is admin OR has at least one space containing a
 *  branch of `pageId` where the caller has an editor-class role. */
export async function canEditPage(pageId: string, caller: UserContext): Promise<boolean> {
  if (caller.isAdmin) return true;
  const spaceIds = await loadAccessibleSpaceIds(caller, { editorOnly: true });
  if (spaceIds.length === 0) return false;
  const { db } = getDb();
  const row = await db
    .select({ exists: sql<number>`1` })
    .from(branches)
    .where(and(eq(branches.pageId, pageId), inArray(branches.spaceId, spaceIds)))
    .limit(1);
  return row.length > 0;
}

/** True when the caller can read at least one branch of `pageId`. */
export async function canReadPage(pageId: string, caller: UserContext): Promise<boolean> {
  if (caller.isAdmin) return true;
  const spaceIds = await loadAccessibleSpaceIds(caller, { editorOnly: false });
  if (spaceIds.length === 0) return false;
  const { db } = getDb();
  const row = await db
    .select({ exists: sql<number>`1` })
    .from(branches)
    .where(and(eq(branches.pageId, pageId), inArray(branches.spaceId, spaceIds)))
    .limit(1);
  return row.length > 0;
}

/** Subset of `spaces.id` that `caller` may interact with.
 *  `editorOnly=true` restricts to spaces where the caller has an
 *  editor-or-better role; `editorOnly=false` returns any space the
 *  caller has any role in (including viewer). Admin returns all. */
export async function loadAccessibleSpaceIds(
  caller: UserContext,
  opts: { editorOnly: boolean } = { editorOnly: false },
): Promise<string[]> {
  const { db } = getDb();
  if (caller.isAdmin) {
    const all = await db.select({ id: spaces.id }).from(spaces);
    return all.map((s) => s.id);
  }
  const groupIds = caller.groupIds ?? [];
  const direct = await db
    .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, caller.id));
  const viaGroup = groupIds.length
    ? await db
        .select({
          spaceId: spaceGroupPermissions.spaceId,
          role: spaceGroupPermissions.role,
        })
        .from(spaceGroupPermissions)
        .where(inArray(spaceGroupPermissions.groupId, groupIds))
    : [];
  const rank: Record<string, number> = { none: 0, viewer: 1, editor: 2, admin: 3 };
  const wantRank: number = opts.editorOnly ? 2 : 1;
  const best = new Map<string, number>();
  for (const r of [...direct, ...viaGroup]) {
    const rk = rank[r.role as string] ?? 0;
    const prev = best.get(r.spaceId) ?? 0;
    if (rk > prev) best.set(r.spaceId, rk);
  }
  return [...best.entries()].filter(([, rk]) => rk >= wantRank).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Create a relation `fromPageId -[type]-> toPageId`. Caller must be
 *  able to edit the source page AND read the target page (the brief's
 *  "don't leak target existence" rule means even the create-time
 *  check matters — you can't create a relation pointing at something
 *  you can't see). */
export async function addRelation(input: CreateRelationInput, caller: UserContext): Promise<OwnedRelation> {
  assertValidType(input.type);
  if (input.fromPageId === input.toPageId) {
    throw new RelationValidationError("a relation cannot point at its source page");
  }

  const { db } = getDb();
  // Verify both pages exist (FK will catch it too, but we want to give a
  // cleaner error and avoid a 500).
  const [src, dst] = await Promise.all([
    db.select({ id: pages.id }).from(pages).where(eq(pages.id, input.fromPageId)).limit(1),
    db.select({ id: pages.id }).from(pages).where(eq(pages.id, input.toPageId)).limit(1),
  ]);
  if (!src.length) throw new RelationValidationError(`source page not found: ${input.fromPageId}`);
  if (!dst.length) throw new RelationValidationError(`target page not found: ${input.toPageId}`);

  if (!(await canEditPage(input.fromPageId, caller))) {
    throw new RelationValidationError("no edit access to source page");
  }
  if (!(await canReadPage(input.toPageId, caller))) {
    throw new RelationValidationError("no read access to target page");
  }

  // Uniqueness: one (page, type, target) tuple per relation.
  const existing = await db
    .select({ id: attributes.id })
    .from(attributes)
    .where(
      and(
        eq(attributes.pageId, input.fromPageId),
        eq(attributes.name, input.type),
        eq(attributes.valuePageId, input.toPageId),
        isNotNull(attributes.valuePageId),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new RelationValidationError(
      `relation '${input.type}' -> ${input.toPageId} already exists on this page`,
    );
  }

  const id = `rel-${randomBytes(8).toString("hex")}`;
  await db.insert(attributes).values({
    id,
    pageId: input.fromPageId,
    name: input.type,
    value: "",
    valuePageId: input.toPageId,
    isPromoted: false,
    position: input.position ?? 0,
  });
  const rows = await db
    .select({
      id: attributes.id,
      name: attributes.name,
      position: attributes.position,
      createdAt: attributes.createdAt,
    })
    .from(attributes)
    .where(eq(attributes.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error("insert succeeded but row not found (race?)");
  }
  return {
    id: row.id,
    type: row.name,
    position: row.position,
    createdAt: row.createdAt,
    target: { id: input.toPageId, title: "" }, // title filled in by listOwnedRelations on read
  };
}

/** Remove a relation by its attribute id. Caller can edit the source
 *  page OR is admin. */
export async function removeRelation(attributeId: string, caller: UserContext): Promise<void> {
  const { db } = getDb();
  const [row] = await db
    .select({ pageId: attributes.pageId, valuePageId: attributes.valuePageId })
    .from(attributes)
    .where(eq(attributes.id, attributeId))
    .limit(1);
  if (!row || row.valuePageId === null) {
    throw new RelationValidationError("relation not found");
  }
  if (!(await canEditPage(row.pageId, caller))) {
    throw new RelationValidationError("no edit access to source page");
  }
  await db.delete(attributes).where(eq(attributes.id, attributeId));
}

/** List relations declared by `pageId` (i.e. this page points outward).
 *  Targets the caller cannot read are omitted entirely — per the brief's
 *  no-existence-leak rule. */
export async function listOwnedRelations(pageId: string, caller: UserContext): Promise<OwnedRelation[]> {
  const { db } = getDb();
  const rows = await db
    .select({
      id: attributes.id,
      name: attributes.name,
      position: attributes.position,
      createdAt: attributes.createdAt,
      targetId: attributes.valuePageId,
    })
    .from(attributes)
    .where(
      and(
        eq(attributes.pageId, pageId),
        isNotNull(attributes.valuePageId),
      ),
    )
    .orderBy(asc(attributes.position), asc(attributes.createdAt));

  if (rows.length === 0) return [];

  // Resolve target page titles; drop those the caller can't read.
  const targetIds = [...new Set(rows.map((r) => r.targetId).filter((x): x is string => !!x))];
  const accessible = await filterReadablePageIds(targetIds, caller);

  // Fetch titles only for accessible targets (single round trip).
  const accessibleList = [...accessible];
  const titles = accessibleList.length
    ? new Map(
        (
          await db
            .select({ id: pages.id, title: pages.title })
            .from(pages)
            .where(inArray(pages.id, accessibleList))
        ).map((r) => [r.id, r.title]),
      )
    : new Map<string, string>();

  return rows
    .filter((r) => r.targetId !== null && accessible.has(r.targetId))
    .map((r) => ({
      id: r.id,
      type: r.name,
      position: r.position,
      createdAt: r.createdAt,
      target: { id: r.targetId as string, title: titles.get(r.targetId as string) ?? "" },
    }));
}

/** List relations pointing at `pageId` from other pages. Sources the
 *  caller cannot read are omitted — no source-existence leak. */
export async function listIncomingRelations(pageId: string, caller: UserContext): Promise<IncomingRelation[]> {
  const { db } = getDb();
  const rows = await db
    .select({
      id: attributes.id,
      name: attributes.name,
      position: attributes.position,
      createdAt: attributes.createdAt,
      sourceId: attributes.pageId,
    })
    .from(attributes)
    .where(and(eq(attributes.valuePageId, pageId), isNotNull(attributes.valuePageId)))
    .orderBy(asc(attributes.position), asc(attributes.createdAt));

  if (rows.length === 0) return [];

  const sourceIds = [...new Set(rows.map((r) => r.sourceId))];
  const accessible = await filterReadablePageIds(sourceIds, caller);
  const titles = accessible.size
    ? new Map(
        (
          await db
            .select({ id: pages.id, title: pages.title })
            .from(pages)
            .where(inArray(pages.id, [...accessible]))
        ).map((r) => [r.id, r.title]),
      )
    : new Map<string, string>();

  return rows
    .filter((r) => accessible.has(r.sourceId))
    .map((r) => ({
      id: r.id,
      type: r.name,
      position: r.position,
      createdAt: r.createdAt,
      source: { id: r.sourceId, title: titles.get(r.sourceId) ?? "" },
    }));
}

/** Helper: returns the subset of `candidatePageIds` the caller can read. */
async function filterReadablePageIds(
  candidatePageIds: string[],
  caller: UserContext,
): Promise<Set<string>> {
  if (candidatePageIds.length === 0) return new Set();
  if (caller.isAdmin) return new Set(candidatePageIds);

  const accessibleSpaceIds = await loadAccessibleSpaceIds(caller, { editorOnly: false });
  if (accessibleSpaceIds.length === 0) return new Set();

  const { db } = getDb();
  // A page is "readable" if at least one of its branches lives in a
  // space the caller can read.
  const rows = await db
    .selectDistinct({ pageId: branches.pageId })
    .from(branches)
    .where(
      and(inArray(branches.pageId, candidatePageIds), inArray(branches.spaceId, accessibleSpaceIds)),
    );
  return new Set(rows.map((r) => r.pageId));
}

/** Used by tests / diagnostics. Returns every (pageId, type, targetPageId)
 *  relation row for `pageId`, including hidden ones, regardless of read
 *  access. Caller is responsible for ensuring they're entitled. */
export async function listOwnedRelationsRaw(pageId: string): Promise<{
  id: string;
  type: string;
  targetPageId: string;
  position: number;
}[]> {
  const { db } = getDb();
  const rows = await db
    .select({
      id: attributes.id,
      name: attributes.name,
      targetId: attributes.valuePageId,
      position: attributes.position,
    })
    .from(attributes)
    .where(and(eq(attributes.pageId, pageId), isNotNull(attributes.valuePageId)))
    .orderBy(asc(attributes.position));
  return rows
    .filter((r) => r.targetId !== null)
    .map((r) => ({
      id: r.id,
      type: r.name,
      targetPageId: r.targetId as string,
      position: r.position,
    }));
}

/** Re-export of the helper used in assertions: "is this attribute row a
 *  relation?"  The application-level invariant is
 *  `valuePageId !== null => value === ""`; non-relations may have a
 *  non-empty value. */
export function isRelationRow(row: { value: string; valuePageId: string | null }): boolean {
  return row.valuePageId !== null;
}
