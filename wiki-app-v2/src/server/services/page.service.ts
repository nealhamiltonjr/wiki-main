import { eq, and, isNull, ne, count } from "drizzle-orm";
import { rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getDb } from "../db/index.js";
import { pages, branches, pageRedirects, attributes, templates } from "../db/schema.js";
import { ensureBlockIds, validateContent, type JSONBlock } from "../../shared/blockIds.js";
import { validateEnvelope } from "../../shared/cryptoEnvelope.js";
import type { PageType } from "../../shared/types.js";
import { getEnabledPluginNodeTypes, getEnabledPluginMarkTypes } from "./plugin.service.js";
import { refreshBacklinks } from "./backlink.service.js";
import { indexPageForSearch, unindexPageForSearch } from "./search.service.js";
import { enqueueJob } from "./queue.service.js";
import { FILES_ROOT } from "./file.service.js";

/** Fresh page content with every block id'd (§7.12d-1). */
export function newPageContent(initial?: unknown): JSONBlock {
  const base = (initial as JSONBlock | undefined) ?? { type: "doc", content: [{ type: "paragraph" }] };
  return ensureBlockIds(base);
}

/** Code pages start empty (a blank file), never with a wiki paragraph doc. */
export function newCodeContent(initial?: unknown): string {
  return typeof initial === "string" ? initial : "";
}

export async function createPage(opts: {
  slug: string;
  title?: string;
  ownerId: string;
  spaceId: string;
  parentBranchId: string | null;
  initialContent?: unknown;
  pageType?: PageType;
  language?: string | null;
  templateId?: string;
}): Promise<{ pageId: string; branchId: string }> {
  // Slice-54: slugs must be unique within a space. Two pages with the same
  // slug in the same space both export to <spaceSlug>/<slug>.md and would
  // race each other in the git flush pipeline (one silently overwrites the
  // other's history). Detect the collision and surface it as 409 from the
  // caller; we don't write any rows in that path.
  if (await slugTakenInSpace(opts.spaceId, opts.slug, null)) {
    throw Object.assign(
      new Error(`A page with slug "${opts.slug}" already exists in this space`),
      { statusCode: 409 },
    );
  }

  const pageId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  const pageType = opts.pageType ?? "wiki";

  // Slice 26 — if a template was chosen, the new page starts from the
  // template page's content, and its non-relation attributes (icon, label,
  // etc.) are copied over so the blueprint is actually useful. The template
  // page itself is unchanged.
  let content = pageType === "code" ? newCodeContent(opts.initialContent) : newPageContent(opts.initialContent);
  let templateAttrs: Array<{ pageId: string; name: string; value: string; valuePageId: string | null; isPromoted: boolean; position: number }> = [];
  if (opts.templateId) {
    const { db } = getDb();
    const [tpl] = await db
      .select({ pageId: templates.pageId })
      .from(templates)
      .where(eq(templates.id, opts.templateId));
    if (!tpl) throw Object.assign(new Error("Template not found"), { statusCode: 404 });
    const [tplPage] = await db.select().from(pages).where(eq(pages.id, tpl.pageId));
    if (tplPage) {
      if (pageType === "code" && typeof tplPage.content === "string") {
        content = tplPage.content;
      } else if (pageType !== "code" && typeof tplPage.content === "object") {
        content = ensureBlockIds(tplPage.content as JSONBlock);
      }
      const tplAttrRows = await db.select().from(attributes).where(eq(attributes.pageId, tplPage.id));
      templateAttrs = tplAttrRows
        .filter((a) => !(a.name === "template" && a.valuePageId))
        .map((a) => ({
          pageId: a.pageId,
          name: a.name,
          value: a.value,
          valuePageId: a.valuePageId,
          isPromoted: a.isPromoted,
          position: a.position,
        }));
    }
  }

  const { db } = getDb();
  db.transaction((tx) => {
    tx.insert(pages).values({
      id: pageId,
      slug: opts.slug,
      title: opts.title?.trim() || opts.slug,
      ownerId: opts.ownerId,
      content,
      pageType,
      language: pageType === "code" ? opts.language ?? null : null,
    }).run();
    tx.insert(branches).values({
      id: branchId,
      pageId,
      parentBranchId: opts.parentBranchId,
      spaceId: opts.spaceId,
      visibility: "inherit",
      isSystem: false,
      createdBy: opts.ownerId,
    }).run();
    for (const a of templateAttrs) {
      tx.insert(attributes).values({
        id: crypto.randomUUID(),
        pageId,
        name: a.name,
        value: a.value,
        valuePageId: a.valuePageId,
        isPromoted: a.isPromoted,
        position: a.position,
      }).run();
    }
  });

  // Git flush pipeline (brief §8 step 10): the initial state of a new page is
  // history-worthy too. Fire-and-forget so page creation is never slowed by a
  // git commit.
  await enqueueJob("git_commit", { pageId, branchId, kind: "autosave" });

  return { pageId, branchId };
}

/**
 * Returns true when `slug` is already used by another (non-trashed) page in
 * `spaceId`. `ignorePageId` excludes a specific page from the check so a
 * rename can keep its own slug without tripping over itself. Used by both
 * create and rename so the rule stays in one place.
 */
async function slugTakenInSpace(spaceId: string, slug: string, ignorePageId: string | null): Promise<boolean> {
  const { db } = getDb();
  const rows = db
    .select({ id: pages.id })
    .from(branches)
    .innerJoin(pages, eq(branches.pageId, pages.id))
    .where(
      and(
        eq(branches.spaceId, spaceId),
        eq(branches.isSystem, false),
        eq(pages.slug, slug),
        isNull(pages.deletedAt),
        ignorePageId ? ne(pages.id, ignorePageId) : undefined,
      ),
    )
    .limit(1)
    .all();
  return rows.length > 0;
}

/** The page (and its branch placement) behind a branch id, for the view/edit route. */
export async function getPageByBranchId(branchId: string) {
  const { db } = getDb();
  const [row] = await db
    .select({ page: pages, branch: branches })
    .from(branches)
    .innerJoin(pages, eq(branches.pageId, pages.id))
    .where(eq(branches.id, branchId));
  if (!row) return null;

  // §13.7: encrypted pages return their CryptoEnvelope as `content` (the client
  // decrypts after a per-session unlock). No server-side content validation —
  // the stored value is ciphertext, not a doc tree or code string.
  if (row.page.isEncrypted) {
    return { ...row, page: { ...row.page, content: row.page.content as unknown } };
  }

  // §13.6: code pages store a plain string, not a Tiptap doc. Skip the JSON
  // integrity validation for them — the "content is a doc tree" invariant only
  // applies to wiki pages.
  if (row.page.pageType === "code") {
    const stored = row.page.content as unknown;
    return { ...row, page: { ...row.page, content: typeof stored === "string" ? stored : "" } };
  }

  // §11.4 data safety: validate content on every read. If the stored JSON
  // has been corrupted (e.g. by a bug in a previous version, or a manual DB
  // edit), repair it in-memory so the client always gets a valid doc tree.
  const stored = row.page.content as unknown;
  const { doc, errors } = validateContent(stored, {
    extraNodeTypes: getEnabledPluginNodeTypes(),
    extraMarkTypes: getEnabledPluginMarkTypes(),
  });
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn("[content-repair-read]", { branchId, pageId: row.page.id, errors });
  }
  return { ...row, page: { ...row.page, content: ensureBlockIds(doc) } };
}

/**
 * OCC-protected save (§3.11). `expectedUpdatedAt` is the timestamp the client
 * loaded; if someone else saved first, the update matches zero rows and we
 * return a conflict instead of silently overwriting their edit.
 *
 * Title edits are independent of body edits: they run outside the OCC gate and
 * do NOT bump updatedAt, so a concurrent title change can't spuriously fail a
 * body save (or vice versa). A title-aware client echoing the current content
 * back is a title-only save and skips the gate entirely.
 */
export async function savePageOCC(opts: {
  pageId: string;
  /** Branch placement used to trace the page's space for the git flush path. */
  branchId: string;
  title?: string;
  titleProvided?: boolean;
  content: unknown;
  expectedUpdatedAt: Date;
  /** §13.7: when true, `content` is a CryptoEnvelope to persist verbatim. */
  encrypted?: boolean;
}): Promise<{ ok: true } | { ok: false; conflict: true } | { ok: false; validationErrors: string[] }> {
  const { db } = getDb();

  // §13.6: code pages have a different content contract (plain string, no
  // block ids, no backlinks). Wiki pages keep the Tiptap validation path.
  const [pageRow] = await db
    .select({ pageType: pages.pageType })
    .from(pages)
    .where(eq(pages.id, opts.pageId));
  const pageType = pageRow?.pageType ?? "wiki";

  if (opts.encrypted) {
    return saveEncryptedPageOCC({ ...opts, content: opts.content });
  }

  if (pageType === "code") {
    if (typeof opts.content !== "string") {
      return { ok: false, validationErrors: ["Code page content must be a string"] };
    }
    return saveCodePageOCC({ ...opts, content: opts.content });
  }

  const { doc, errors } = validateContent(opts.content, {
    extraNodeTypes: getEnabledPluginNodeTypes(),
    extraMarkTypes: getEnabledPluginMarkTypes(),
  });
  const content = ensureBlockIds(doc);

  if (errors.some((e) => e.includes("unknown node type"))) {
    return { ok: false, validationErrors: errors };
  }
  // Auto-repairs are logged but not fatal — the repaired doc is saved.
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn("[content-repair]", { pageId: opts.pageId, errors });
  }

  if (opts.title !== undefined) {
    await db.update(pages).set({ title: opts.title }).where(eq(pages.id, opts.pageId));
  }

  if (opts.titleProvided) {
    const [current] = await db.select({ content: pages.content }).from(pages).where(eq(pages.id, opts.pageId));
    const contentUnchanged = current && isDeepStrictEqual(current.content, content);
    if (contentUnchanged) {
      // Title-only save: the title change is still part of git history (it
      // lives in the exported frontmatter), so it still enqueues a commit.
      await enqueueJob("git_commit", { pageId: opts.pageId, branchId: opts.branchId, kind: "autosave" });
      return { ok: true };
    }
  }

  const result = await db
    .update(pages)
    // A normal save on a previously encrypted page is the "unprotect" path: the
    // client already decrypted, and the plaintext doc it sends replaces the
    // envelope. isEncrypted is cleared here so read validation resumes.
    .set({ content: content as never, isEncrypted: false, updatedAt: new Date() })
    .where(and(eq(pages.id, opts.pageId), eq(pages.updatedAt, opts.expectedUpdatedAt)));

  const changes = (result as unknown as { changes: number }).changes;
  if (changes === 0) return { ok: false, conflict: true };

  const [saved] = await db.select({ title: pages.title, content: pages.content }).from(pages).where(eq(pages.id, opts.pageId));
  if (saved) {
    // Search index + backlinks are derived data, refreshed on every save so
    // they can never drift from the content (fresh scan each write).
    indexPageForSearch(opts.pageId, saved.title, saved.content);
    await refreshBacklinks(opts.pageId, saved.content);
  }

  // Git flush pipeline: every successful content save is history-worthy.
  // Fire-and-forget so the save response is never delayed by a git commit.
  await enqueueJob("git_commit", { pageId: opts.pageId, branchId: opts.branchId, kind: "autosave" });

  return { ok: true };
}

/**
 * Code-page save path (§13.6). Content is a plain string; there are no block
 * ids to repair and no backlinks to scan (code pages don't carry wiki links).
 * Search still indexes the raw text so a snippet of a script is findable.
 */
async function saveCodePageOCC(opts: {
  pageId: string;
  branchId: string;
  title?: string;
  titleProvided?: boolean;
  content: string;
  expectedUpdatedAt: Date;
}): Promise<{ ok: true } | { ok: false; conflict: true } | { ok: false; validationErrors: string[] }> {
  const { db } = getDb();

  if (opts.title !== undefined) {
    await db.update(pages).set({ title: opts.title }).where(eq(pages.id, opts.pageId));
  }

  if (opts.titleProvided) {
    const [current] = await db.select({ content: pages.content }).from(pages).where(eq(pages.id, opts.pageId));
    const contentUnchanged = current && current.content === opts.content;
    if (contentUnchanged) {
      await enqueueJob("git_commit", { pageId: opts.pageId, branchId: opts.branchId, kind: "autosave" });
      return { ok: true };
    }
  }

  const result = await db
    .update(pages)
    .set({ content: opts.content as never, isEncrypted: false, updatedAt: new Date() })
    .where(and(eq(pages.id, opts.pageId), eq(pages.updatedAt, opts.expectedUpdatedAt)));

  const changes = (result as unknown as { changes: number }).changes;
  if (changes === 0) return { ok: false, conflict: true };

  const [saved] = await db.select({ title: pages.title, content: pages.content }).from(pages).where(eq(pages.id, opts.pageId));
  if (saved) {
    indexPageForSearch(opts.pageId, saved.title, saved.content);
    // No refreshBacklinks: code content has no internal wiki-link marks.
  }

  await enqueueJob("git_commit", { pageId: opts.pageId, branchId: opts.branchId, kind: "autosave" });
  return { ok: true };
}

/**
 * Encrypted-page save path (§13.7). The body is a CryptoEnvelope that the
 * server persists verbatim — it cannot decrypt, validate, index, or export the
 * plaintext. Search, backlinks, mentions, and git are all deliberately skipped;
 * the only server-side work is shape validation, OCC, and clearing any stale
 * search index left from before the page was protected.
 */
async function saveEncryptedPageOCC(opts: {
  pageId: string;
  title?: string;
  content: unknown;
  expectedUpdatedAt: Date;
}): Promise<{ ok: true } | { ok: false; conflict: true } | { ok: false; validationErrors: string[] }> {
  const { db } = getDb();

  try {
    validateEnvelope(opts.content);
  } catch (err) {
    return { ok: false, validationErrors: [err instanceof Error ? err.message : "Invalid encrypted envelope"] };
  }

  // Titles remain plaintext so the tree/list can still render a name; only the
  // page body is encrypted at rest (§13.7 v1 limitation, documented in AGENTS).
  if (opts.title !== undefined) {
    await db.update(pages).set({ title: opts.title }).where(eq(pages.id, opts.pageId));
  }

  const result = await db
    .update(pages)
    .set({ content: opts.content as never, isEncrypted: true, updatedAt: new Date() })
    .where(and(eq(pages.id, opts.pageId), eq(pages.updatedAt, opts.expectedUpdatedAt)));

  const changes = (result as unknown as { changes: number }).changes;
  if (changes === 0) return { ok: false, conflict: true };

  unindexPageForSearch(opts.pageId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Trash (soft delete, brief §12.1) — the fast "I didn't mean to delete that"
// path, kept deliberately simple: a deleted page is a row with deletedAt set,
// hidden from the tree, restorable in one call, and purgeable for real.
// ---------------------------------------------------------------------------

/** Soft-deletes a branch placement. Last live placement -> the page itself goes to trash. */
export async function softDeleteBranch(branchId: string): Promise<void> {
  const { db } = getDb();
  const [row] = await db
    .select({ pageId: branches.pageId })
    .from(branches)
    .where(eq(branches.id, branchId));
  if (!row) return;

  const [liveCountRow] = await db
    .select({ n: count() })
    .from(branches)
    .innerJoin(pages, eq(branches.pageId, pages.id))
    .where(and(eq(branches.pageId, row.pageId), isNull(pages.deletedAt)));
  const liveCount = liveCountRow?.n ?? 0;

  if (liveCount <= 1) {
    // Last live placement: trash the page (soft delete). Every placement of
    // this page disappears from the tree with it; restoring revives all of them.
    await db.update(pages).set({ deletedAt: new Date() }).where(eq(pages.id, row.pageId));
  } else {
    // More placements exist: remove just this placement.
    await db.delete(branches).where(eq(branches.id, branchId));
  }
}

/** Restores a soft-deleted page (clears deletedAt on every placement). */
export async function restorePage(pageId: string): Promise<void> {
  const { db } = getDb();
  await db.update(pages).set({ deletedAt: null }).where(eq(pages.id, pageId));
}

/** Hard-deletes a page (cascade removes all placements, files, attributes). */
export async function purgePage(pageId: string): Promise<void> {
  const { db } = getDb();
  // branches.parentBranchId has no onDelete cascade (deliberate: deleting a
  // parent branch shouldn't silently delete children — they become root-level).
  // When purging a page, null out any child branch's parentBranchId first so
  // the cascade from pages → branches doesn't trip SQLite's FK RESTRICT.
  const pageBranchIds = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.pageId, pageId))
    .all();
  const pageBranchIdSet = new Set(pageBranchIds.map(b => b.id));
  if (pageBranchIdSet.size > 0) {
    const allBranches = await db.select({ id: branches.id, parentBranchId: branches.parentBranchId }).from(branches);
    for (const b of allBranches) {
      if (b.parentBranchId && pageBranchIdSet.has(b.parentBranchId)) {
        await db.update(branches).set({ parentBranchId: null }).where(eq(branches.id, b.id));
      }
    }
  }
  await db.delete(pages).where(eq(pages.id, pageId));
  unindexPageForSearch(pageId);

  // Slice-53: remove the page's on-disk file directory. The DB cascade on
  // files.pageId already deleted the row, but the bytes under
  // FILES_ROOT/<pageId>/ are now unreachable from the schema. Without
  // this sweep every purge leaks the entire per-page directory; after a
  // few years of trash cycling, data/files would grow without bound.
  // Best-effort: a failed rm is logged but doesn't unwind the purge
  // (the DB rows are already gone, the user has already confirmed).
  const pageDir = path.join(FILES_ROOT, pageId);
  try {
    // Defense-in-depth: assert the resolved path stays inside FILES_ROOT
    // so a future bug that drops a `..` segment into pageId doesn't
    // escalate to an arbitrary-directory rm. The slug schema already
    // rejects `..`, but the outer bracket guards against regressions
    // here.
    const resolved = path.resolve(pageDir);
    const root = path.resolve(FILES_ROOT) + path.sep;
    if (resolved.startsWith(root)) {
      await rm(resolved, { recursive: true, force: true });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[purge] file cleanup failed:", { pageId, err: String(err) });
  }
}

/** Soft-deletes a page EVERYWHERE: removes every placement, then trashes the page. */
export async function deletePageEverywhere(pageId: string): Promise<void> {
  const { db } = getDb();
  db.transaction((tx) => {
    tx.delete(branches).where(eq(branches.pageId, pageId)).run();
    tx.update(pages).set({ deletedAt: new Date() }).where(eq(pages.id, pageId)).run();
  });
  unindexPageForSearch(pageId);
}

/**
 * Renames a page (the slug lives on the page, shared by every placement).
 *
 * Side effect (brief §12.2): for every space the page is currently placed
 * in, record the OLD slug as a redirect to this pageId before overwriting
 * it. The composite PK (spaceId, oldSlug) means a re-rename back to one of
 * this page's own old slugs overwrites the redirect back to the live page —
 * we never let a stale alias linger after a self-undo. The git queue
 * receives the oldSlug separately so it can `git rm` the old file path
 * (slice-10 invariant).
 *
 * Caller is responsible for the permission check (the rename route already
 * gates on `minRole: "editor"` via the access middleware) and for enqueueing
 * the git_commit with `oldSlug` in its payload.
 */
export async function renamePage(pageId: string, slug: string): Promise<boolean> {
  const { db } = getDb();

  const existing = await db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, pageId)).limit(1);
  const oldSlug = existing[0]?.slug;
  if (!oldSlug) return false;
  // No-op rename: don't write a redirect to itself or churn the timestamp.
  if (oldSlug === slug) return true;

  // Slice-54: a rename can't land on a slug already used by another page in
  // any of this page's spaces (otherwise the two pages would share a git
  // file path and the rename's autosave commit would silently overwrite the
  // existing page's history). We check per-placement so a page placed in
  // space A can still be renamed even if space B already has that slug —
  // each space has its own independent slug namespace; only collisions
  // within a single space matter.
  const placements = db
    .select({ spaceId: branches.spaceId })
    .from(branches)
    .where(eq(branches.pageId, pageId))
    .all();
  for (const p of placements) {
    if (await slugTakenInSpace(p.spaceId, slug, pageId)) {
      throw Object.assign(
        new Error(`A page with slug "${slug}" already exists in this space`),
        { statusCode: 409 },
      );
    }
  }

  await db.transaction((tx) => {
    for (const p of placements) {
      tx.insert(pageRedirects)
        .values({ spaceId: p.spaceId, oldSlug, pageId })
        .onConflictDoUpdate({
          target: [pageRedirects.spaceId, pageRedirects.oldSlug],
          set: { pageId, createdAt: new Date() },
        })
        .run();
    }
    tx.update(pages).set({ slug }).where(eq(pages.id, pageId)).run();
  });

  return true;
}

/** Lists soft-deleted pages in a space, for the per-space Trash view. */
export async function listTrash(spaceId: string) {
  const { db } = getDb();
  return db
    .select({ branchId: branches.id, pageId: pages.id, slug: pages.slug, title: pages.title, deletedAt: pages.deletedAt })
    .from(branches)
    .innerJoin(pages, eq(branches.pageId, pages.id))
    .where(and(eq(branches.spaceId, spaceId), eq(branches.isSystem, false)))
    .all()
    .filter((r) => r.deletedAt !== null);
}

export interface ResolvedSlug {
  pageId: string;
  branchId: string;
  slug: string;
  /** True when the slug wasn't found live and was resolved via an alias row. */
  redirected: boolean;
  /** The original slug the caller asked about (present iff `redirected`). */
  oldSlug?: string;
}

/**
 * Resolve `slug` in the given space: either the live page (with at least one
 * non-system, non-trashed branch in this space) OR an alias row recorded by
 * a prior `renamePage`. Returns null when neither exists.
 *
 * Brief §12.2: a redirect target is gated by the same permission check as
 * the live page — see the `/api/spaces/:spaceId/resolve-slug` route, which
 * re-walks the resolved branch through `resolveAccess` before returning the
 * answer to the client. This service trusts its callers to do that gate.
 */
export async function resolveSlug(spaceId: string, slug: string): Promise<ResolvedSlug | null> {
  const { db } = getDb();

  const live = db
    .select({ branchId: branches.id, pageId: pages.id, slug: pages.slug })
    .from(branches)
    .innerJoin(pages, eq(branches.pageId, pages.id))
    .where(
      and(
        eq(branches.spaceId, spaceId),
        eq(branches.isSystem, false),
        eq(pages.slug, slug),
        isNull(pages.deletedAt)
      )
    )
    .orderBy(branches.position)
    .limit(1)
    .all();
  if (live[0]) return { ...live[0], redirected: false };

  const redirect = db
    .select({
      pageId: pageRedirects.pageId,
      slug: pages.slug,
      deletedAt: pages.deletedAt,
    })
    .from(pageRedirects)
    .innerJoin(pages, eq(pages.id, pageRedirects.pageId))
    .where(and(eq(pageRedirects.spaceId, spaceId), eq(pageRedirects.oldSlug, slug)))
    .limit(1)
    .all();
  const r = redirect[0];
  if (!r || r.deletedAt !== null) return null;

  // The page still has at least one branch in this space? If it was removed
  // from this space post-rename, the alias is dangling — treat as 404 so we
  // don't surface a page the user can't open here.
  const stillPlaced = db
    .select({ branchId: branches.id })
    .from(branches)
    .where(
      and(eq(branches.pageId, r.pageId), eq(branches.spaceId, spaceId), eq(branches.isSystem, false))
    )
    .limit(1)
    .all();
  if (!stillPlaced[0]) return null;

  return {
    pageId: r.pageId,
    branchId: stillPlaced[0].branchId,
    slug: r.slug,
    redirected: true,
    oldSlug: slug,
  };
}

/** Active redirects that point AT a given page. Exposed for the read API
 * so admin/maintenance views can see what aliases a page is currently
 * serving under across every space. Filters out rows whose `oldSlug`
 * matches the page's current slug — those are stale (the page was
 * renamed back to one of its own previous aliases; the row is preserved
 * for audit but is no longer a useful redirect). */
export async function listRedirectsForPage(pageId: string) {
  const { db } = getDb();
  const current = await db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, pageId)).limit(1);
  const liveSlug = current[0]?.slug;
  const rows = await db
    .select({ spaceId: pageRedirects.spaceId, oldSlug: pageRedirects.oldSlug, createdAt: pageRedirects.createdAt })
    .from(pageRedirects)
    .where(eq(pageRedirects.pageId, pageId))
    .all();
  return liveSlug === undefined ? rows : rows.filter((r) => r.oldSlug !== liveSlug);
}
