import { Hocuspocus } from "@hocuspocus/server";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import { eq, and, isNull } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";

import { getDb } from "../db/index.js";
import { pages, branches, collabDocuments } from "../db/schema.js";
import { baseExtensions } from "../../features/editor/editorExtensions.js";
import { getUserContext, getUserContextById } from "./auth.service.js";
import { getBranchChain, resolveSpaceRole } from "./branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import { resolveToken } from "./token.service.js";
import { ensureBlockIds, validateContent, filterUnknownNodes, type JSONBlock, KNOWN_BLOCK_TYPES, KNOWN_INLINE_TYPES, KNOWN_MARK_TYPES } from "../../shared/blockIds.js";
import { getEnabledPluginNodeTypes, getEnabledPluginMarkTypes } from "./plugin.service.js";
import { indexPageForSearch } from "./search.service.js";
import { refreshBacklinks } from "./backlink.service.js";
import { enqueueJob } from "./queue.service.js";
import type { UserContext } from "../../shared/types.js";

const RANK = { none: 0, viewer: 1, editor: 2, admin: 3 } as const;

/**
 * The Yjs/ProseMirror schema used to seed collab documents from persisted page
 * content. Built once from the SAME extension list the editor uses, so the
 * seeded document's node/mark set exactly matches what the Collaboration
 * extension on the client will read back ("default" fragment).
 */
const collabSchema = getSchema(baseExtensions());

/**
 * In-memory live-document cache (one Doc per open collaboration session).
 * `collab_documents` is the durable store; this map avoids re-decoding the
 * update binary on every reconnect.
 *
 * Phase 4.5 — LRU eviction. The cache is bounded to MAX_DOCS entries. When
 * the limit is reached, the least-recently-accessed doc is evicted (its
 * latest state is persisted to `collab_documents` via storeDocument first,
 * so a reconnect re-seeds from the durable store without data loss).
 */
const MAX_DOCS = 50;
const docs = new Map<string, Doc>();
// Track access order for LRU. Map iteration order = insertion order in JS,
// so we delete + re-set on access to move the key to the end (most-recent).
function touchDoc(key: string): void {
  const doc = docs.get(key);
  if (doc) { docs.delete(key); docs.set(key, doc); }
}
async function evictIfNeeded(): Promise<void> {
  while (docs.size > MAX_DOCS) {
    const oldest = docs.keys().next().value;
    if (oldest === undefined) break;
    const doc = docs.get(oldest);
    docs.delete(oldest);
    // Persist the evicted doc's state to the durable store so reconnect works.
    if (doc) {
      try {
        const { storeDocument } = await import("./collab.service.js");
        await storeDocument(oldest, doc);
      } catch { /* best-effort — the next reconnect will re-seed from disk */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Principal + eligibility resolution — exported separately so integration
// tests can exercise the exact auth/eligibility gates the Hocuspocus
// onAuthenticate hook enforces (the WebSocket upgrade path itself is thin).
// ---------------------------------------------------------------------------

/**
 * Resolves the principal for a collab connection, mirroring the REST
 * middleware: a bearer API token first (account-scoped, no password — a
 * password-protected token can't be used over a WebSocket), then the
 * better-auth session cookie carried by the upgrade request.
 */
export async function resolveCollabPrincipal(
  token: string | undefined,
  requestHeaders: Headers
): Promise<{ user: UserContext; source: "session" | "token" } | null> {
  if (token) {
    const resolved = await resolveToken(token).catch(() => null);
    if (resolved && !resolved.passwordHash && resolved.scopeType === "account") {
      try {
        const user = await getUserContextById(resolved.createdBy);
        return { user, source: "token" };
      } catch {
        return null;
      }
    }
  }
  const user = await getUserContext(requestHeaders);
  return user ? { user, source: "session" } : null;
}

/**
 * Maps the collab document name (the BRANCH id the client opens; PAGE ids are
 * also accepted for tooling) to the branch chain + page, or null when the
 * page/branch doesn't exist.
 */
export async function resolveCollabChain(documentName: string) {
  const { db } = getDb();
  const [byBranch] = await db.select().from(branches).where(eq(branches.id, documentName));
  let branch = byBranch;
  if (branch) return { chain: await getBranchChain(branch.id), pageId: branch.pageId, branchId: branch.id };

  const [byPage] = await db
    .select({ id: branches.id, pageId: branches.pageId })
    .from(branches)
    .innerJoin(pages, eq(pages.id, branches.pageId))
    .where(and(eq(branches.pageId, documentName), eq(branches.isSystem, false), isNull(pages.deletedAt)))
    .limit(1);
  branch = byPage as typeof byBranch | undefined;
  if (branch) return { chain: await getBranchChain(branch.id), pageId: branch.pageId, branchId: branch.id };
  return null;
}

/**
 * THE collab gate (brief §8 step 11 / §3.7 single-placement rule). Returns
 * `{ ok: true, pageId, branchId }` when the user may join, or `{ ok: false,
 * error }` describing why not. Enforced at onAuthenticate; shared with tests.
 */
export async function checkCollabEligibility(
  user: UserContext,
  documentName: string
): Promise<{ ok: true; pageId: string; branchId: string } | { ok: false; error: string }> {
  const resolved = await resolveCollabChain(documentName);
  if (!resolved) return { ok: false, error: "Document not found" };

  const chain = resolved.chain;
  const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
  const access = resolveAccess(user, chain, spaceRole);
  if (RANK[access] < RANK.editor) {
    return { ok: false, error: "Editor access required for collaboration" };
  }

  // Collaboration is only safe for pages with a single placement: the Yjs
  // document is keyed by branch id, but the page content they all share is
  // written back on store — a cloned page would otherwise let edits from one
  // space overwrite the content visible in every other placement.
  const { db } = getDb();
  const placements = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.pageId, resolved.pageId), eq(branches.isSystem, false)));
  if (placements.length > 1) {
    return { ok: false, error: "Collaboration is only available for pages with a single placement" };
  }

  // §13.7: live collaboration broadcasts every edit to the server (via the
  // Yjs doc) and to every other participant. The encrypted-page model is
  // that the server never sees plaintext — only the wrapped DEK + ciphertext
  // body. Let a collab session open on an encrypted page and the server's
  // storeDocument write-back would clobber the envelope with the in-memory
  // Tiptap doc, leaking plaintext to the DB, the search index, and the git
  // flush pipeline. Block at the gate so the UI never offers "Live edit…"
  // for these pages either.
  const [page] = await db.select({ isEncrypted: pages.isEncrypted }).from(pages).where(eq(pages.id, resolved.pageId));
  if (page?.isEncrypted) {
    return { ok: false, error: "Collaboration is not available on encrypted pages" };
  }

  return { ok: true, pageId: resolved.pageId, branchId: resolved.branchId };
}

// ---------------------------------------------------------------------------
// Document load/store — the same single DB connection as every other service
// (brief §3.2: collab persistence must NOT open a second connection).
// ---------------------------------------------------------------------------

function decodeStoredUpdate(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** Seeds a fresh Yjs doc from the page's persisted content (block ids intact). */
async function seedDocFromPage(pageId: string): Promise<Doc> {
  const doc = new Doc();
  try {
    const { db } = getDb();
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
    if (page?.content) {
      // ensureBlockIds before seeding so a fresh collab session on an old page
      // still gets id'd blocks (comments/refs depend on them), matching what a
      // normal autosave write path produces. Also filter unknown node types:
      // if a plugin was disabled, its declared node types are no longer in the
      // enabled set, so content containing them would crash Tiptap's schema
      // construction on the client. Filtered nodes become paragraphs (§4.4).
      const raw = ensureBlockIds(page.content as JSONBlock);
      const pluginNodes = getEnabledPluginNodeTypes();
      const pluginMarks = getEnabledPluginMarkTypes();
      const blockTypes = new Set([...KNOWN_BLOCK_TYPES, ...pluginNodes]);
      const markTypes = new Set([...KNOWN_MARK_TYPES, ...pluginMarks]);
      const content = filterUnknownNodes(raw, blockTypes, KNOWN_INLINE_TYPES, markTypes);
      const seed = prosemirrorJSONToYDoc(collabSchema, content as never, "default");
      applyUpdate(doc, encodeStateAsUpdate(seed));
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[collab-seed]", { pageId, error: String(err) });
  }
  return doc;
}

/** Loads (or creates + seeds) the live document for a branch id. */
export async function loadOrCreateDoc(documentName: string): Promise<Doc> {
  const cached = docs.get(documentName);
  if (cached) { touchDoc(documentName); return cached; }

  const { db } = getDb();
  const [stored] = await db.select().from(collabDocuments).where(eq(collabDocuments.name, documentName));
  const doc = new Doc();
  if (stored) {
    applyUpdate(doc, decodeStoredUpdate(stored.data));
  } else {
    // First-ever collab session: seed from the page's persisted content so the
    // editor doesn't start from an empty doc (a real bug in the old app —
    // toggling collab on wiped the visible content). Seeding on the server
    // (single writer) avoids two clients both seeding and duplicating content.
    const [branch] = await db.select().from(branches).where(eq(branches.id, documentName));
    if (branch) {
      const seeded = await seedDocFromPage(branch.pageId);
      return cacheDoc(documentName, seeded);
    }
  }
  return cacheDoc(documentName, doc);
}

function cacheDoc(name: string, doc: Doc): Doc {
  docs.set(name, doc);
  void evictIfNeeded();
  return doc;
}

/**
 * Persists a collab document to `collab_documents` and writes the live content
 * back to the page row so the git flush pipeline, search index, and backlinks
 * stay in sync with what collaborators actually see. The old app never wrote
 * collab content back to pages.content — toggling collab off silently reverted
 * every edit made during the session. Writing back on store (which Hocuspocus
 * fires after its debounce window) keeps the page durable without racing the
 * OCC-gated autosave path (autosave is paused while collab is active).
 */
export async function storeDocument(documentName: string, document: Doc): Promise<void> {
  const { db } = getDb();
  const update = encodeStateAsUpdate(document);
  await db
    .insert(collabDocuments)
    .values({ name: documentName, data: Buffer.from(update).toString("base64") })
    .onConflictDoUpdate({
      target: collabDocuments.name,
      set: { data: Buffer.from(update).toString("base64"), updatedAt: new Date() },
    });
  docs.set(documentName, document);

  // Write back to the page — only when the content actually changed, so an
  // idle session never churns pages.updatedAt or enqueues no-op commits.
  const [branch] = await db.select().from(branches).where(eq(branches.id, documentName));
  if (!branch) return; // branch deleted mid-session; doc is still persisted
  const [page] = await db.select().from(pages).where(eq(pages.id, branch.pageId));
  if (!page) return;

  let json: unknown;
  try {
    json = yDocToProsemirrorJSON(document, "default");
  } catch {
    return; // schema mismatch (e.g. a plugin node type uninstalled) — keep the Yjs state, don't clobber the page
  }
  const { doc: validated, errors } = validateContent(json, {
    extraNodeTypes: getEnabledPluginNodeTypes(),
    extraMarkTypes: getEnabledPluginMarkTypes(),
  });
  const content = ensureBlockIds(validated);
  if (errors.some((e) => e.includes("unknown node type"))) return;

  if (isDeepStrictEqual(page.content, content)) return;

  await db.update(pages).set({ content: content as never, updatedAt: new Date() }).where(eq(pages.id, page.id));
  indexPageForSearch(page.id, page.title, content);
  await refreshBacklinks(page.id, content);
  await enqueueJob("git_commit", { pageId: page.id, branchId: branch.id, kind: "autosave" });
}

// ---------------------------------------------------------------------------
// Hocuspocus instance — attached to the HTTP server's upgrade handler in
// index.ts (NOT in buildApp, so `.inject()` tests never touch the socket).
// ---------------------------------------------------------------------------

export const hocuspocus = new Hocuspocus({
  name: "wiki-collab",
  timeout: 30000,
  debounce: 2000,
  maxDebounce: 10000,

  async onAuthenticate({ token, documentName, requestHeaders }) {
    const principal = await resolveCollabPrincipal(token ?? undefined, requestHeaders);
    if (!principal) throw new Error("Authentication required");

    const result = await checkCollabEligibility(principal.user, documentName);
    if (!result.ok) throw new Error(result.error);

    return { user: principal.user, pageId: result.pageId, branchId: result.branchId };
  },

  async onLoadDocument({ documentName }) {
    return loadOrCreateDoc(documentName);
  },

  async onStoreDocument({ documentName, document }) {
    await storeDocument(documentName, document);
  },
});
