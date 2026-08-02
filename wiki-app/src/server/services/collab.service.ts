import { Hocuspocus } from "@hocuspocus/server";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";
import BetterSqlite3 from "better-sqlite3";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches } from "../db/schema.js";
import { baseEditorExtensions } from "../../client/features/editor/baseExtensions.js";
import { getUserContext, getUserContextById } from "./auth.service.js";
import { getBranchChain, resolveSpaceRole } from "./branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import { resolveToken } from "./token.service.js";
import { log } from "./log.service.js";
import { ensureBlockIds, type JSONBlock } from "../../shared/blockIds.js";
import type { UserContext } from "../../shared/types.js";

const DB_PATH = process.env.DB_PATH || "./data/wiki.db";

let sqlite: BetterSqlite3.Database | null = null;

function getDb(): BetterSqlite3.Database {
  if (!sqlite) {
    sqlite = new BetterSqlite3(DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");
  }
  return sqlite;
}

function ensureTable() {
  getDb().exec(
    "CREATE TABLE IF NOT EXISTS collab_documents (name TEXT PRIMARY KEY, data BLOB NOT NULL)"
  );
}

function loadFromDb(name: string): Uint8Array | null {
  ensureTable();
  const row = getDb().prepare("SELECT data FROM collab_documents WHERE name = ?").get(name) as { data: Buffer } | undefined;
  return row ? new Uint8Array(row.data) : null;
}

function saveToDb(name: string, data: Uint8Array) {
  ensureTable();
  getDb().prepare(
    "INSERT INTO collab_documents (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data"
  ).run(name, Buffer.from(data));
}

const docs = new Map<string, Doc>();

const RANK = { none: 0, viewer: 1, editor: 2, admin: 3 } as const;

/**
 * Resolves the principal (user) for a collab connection, mirroring the REST
 * middleware: a bearer credential first, then the better-auth session cookie
 * from the WebSocket upgrade request. The provider's `token` option is the
 * only credential a non-browser client can easily send, so it is accepted as
 * a bearer credential too (password-protected tokens are NOT - there's no way
 * to supply the password over a collab connection, same rule as the REST
 * bearer engine).
 */
async function resolveCollabPrincipal(
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
 * Maps the collab document name (the client passes the PAGE id; branch ids are
 * also accepted for tooling) to a branch chain for permission resolution.
 * Returns null if the page/branch doesn't exist or has no placements.
 */
async function resolveCollabChain(documentName: string) {
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

export const hocuspocus = new Hocuspocus({
  name: "wiki-collab",
  timeout: 30000,
  debounce: 2000,
  maxDebounce: 10000,

  async onAuthenticate({ token, documentName, requestHeaders }) {
    const principal = await resolveCollabPrincipal(token ?? undefined, requestHeaders);
    if (!principal) throw new Error("Authentication required");

    const resolved = await resolveCollabChain(documentName);
    if (!resolved) throw new Error("Document not found");

    const chain = resolved.chain;
    const spaceRole = await resolveSpaceRole(principal.user.id, chain[0]!.spaceId, principal.user.groupIds);
    const access = resolveAccess(principal.user, chain, spaceRole);
    if (RANK[access] < RANK.editor) {
      throw new Error("Editor access required for collaboration");
    }

    // Collaboration is only safe for pages with a single placement: the Yjs
    // document is keyed by page id, so a cloned page would otherwise share one
    // live document across every space it's placed in, leaking edits across
    // security boundaries (the rule from the original design, §7.8).
    const placements = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.pageId, resolved.pageId), eq(branches.isSystem, false)));
    if (placements.length > 1) {
      throw new Error("Collaboration is only available for pages with a single placement");
    }

    log("info", "collab", `Authenticated collab connection for ${documentName} (${principal.source})`);
    return { user: principal.user, pageId: resolved.pageId, branchId: resolved.branchId };
  },

  async onConnect() {
    log("info", "collab", "Client connected");
  },

  async onLoadDocument({ documentName }) {
    log("info", "collab", `onLoadDocument called for ${documentName}`);

    let doc = docs.get(documentName);
    if (doc) return doc;

    doc = new Doc();
    const stored = loadFromDb(documentName);
    if (stored) {
      applyUpdate(doc, stored);
      log("info", "collab", `Loaded document ${documentName} from DB`);
    } else {
      // First-ever collab session for this page: seed the Yjs document with the
      // page's persisted content so the editor doesn't start from an empty doc
      // (a real bug - toggling collab on wiped the visible content). Seeding on
      // the server (single writer) avoids two clients both seeding and creating
      // duplicate content. The documentName is a BRANCH id (that's what the
      // client passes to the provider), so resolve it through the branches
      // table to the owning page first.
      try {
        const [branch] = await db.select().from(branches).where(eq(branches.id, documentName));
        const pageId = branch?.pageId ?? documentName;
        const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
        if (page?.content) {
          // Phase 1 (§7.12): backfill block ids on pre-Phase-1 content before
          // seeding, so a fresh collab session on an old page still gets id'd
          // blocks (comments/refs depend on them).
          const content = ensureBlockIds(page.content as JSONBlock);
          const schema = getSchema(baseEditorExtensions());
          // NOTE: prosemirrorJSONToYDoc(schema, state, xmlFragment) — argument
          // order matters (passing (state, schema) made Node.fromJSON treat the
          // JSON as the schema and the schema as the state → "Invalid mark data").
          // The third arg MUST match the fragment @tiptap/extension-collaboration
          // binds to (its default `field: "default"`); seeding into y-prosemirror's
          // default "prosemirror" fragment left the editor reading an empty
          // "default" fragment → collab pages appeared blank.
          const seed = prosemirrorJSONToYDoc(schema, content as any, "default");
          applyUpdate(doc, encodeStateAsUpdate(seed));
          log("info", "collab", `Seeded document ${documentName} from page content`);
        } else {
          log("info", "collab", `No page content found to seed document ${documentName}`);
        }
      } catch (err) {
        log("error", "collab", `Failed to seed document ${documentName}`, { error: String(err) });
      }
    }
    docs.set(documentName, doc);
    return doc;
  },

  async onStoreDocument({ documentName, document }) {
    const state = encodeStateAsUpdate(document);
    saveToDb(documentName, state);
    docs.set(documentName, document);
  },
});

log("info", "collab", "Hocuspocus collaboration server configured");

