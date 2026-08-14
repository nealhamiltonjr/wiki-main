import { getDb } from "../db/index.js";
import { accessibleBranchIds, getBranchChain, resolveSpaceRole } from "./branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { BranchContext, SpaceRole, UserContext } from "../../shared/types.js";

interface PMNode {
  type: string;
  content?: PMNode[];
  text?: string;
  attrs?: Record<string, unknown>;
}

/** Concatenates all plain text from a Tiptap/ProseMirror JSON doc, or returns
 *  a raw string (code pages, §13.6) unchanged so code content is searchable. */
export function docToText(doc: unknown): string {
  if (typeof doc === "string") {
    try {
      const parsed = JSON.parse(doc) as PMNode | null;
      if (parsed && parsed.type === "doc") {
        return walkDoc(parsed);
      }
    } catch {
      // not JSON — treat the string itself as the page body (code page).
    }
    return doc.replace(/\s+/g, " ").trim();
  }
  return walkDoc(doc as PMNode | null);
}

function walkDoc(json: PMNode | null): string {
  if (!json || json.type !== "doc") return "";
  const parts: string[] = [];
  const walk = (node: PMNode) => {
    if (node.type === "text") parts.push(node.text ?? "");
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(json);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Inserts/replaces the FTS row for a page. Called on every page save. */
export function indexPageForSearch(pageId: string, title: string, content: unknown): void {
  const { sqlite } = getDb();
  // rowid is an integer; the page id is a UUID string, so keep page_id as the
  // lookup column and let SQLite own rowid. Delete-then-insert is equivalent
  // to INSERT OR REPLACE here because page_id is not the rowid.
  sqlite.prepare("DELETE FROM page_fts WHERE page_id = ?").run(pageId);
  sqlite
    .prepare("INSERT INTO page_fts(page_id, title, body) VALUES (?, ?, ?)")
    .run(pageId, title, docToText(content));
}

/** Removes a page from the FTS index (hard delete / purge). */
export function unindexPageForSearch(pageId: string): void {
  const { sqlite } = getDb();
  sqlite.prepare("DELETE FROM page_fts WHERE page_id = ?").run(pageId);
}

export interface SearchResult {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  snippet: string;
  spaceId: string;
  spaceName: string;
}

export interface SpaceSearchResult {
  id: string;
  name: string;
  pageCount: number;
}

/** FTS5 boolean keywords that must be quoted to be treated as plain terms. */
const FTS_OPERATORS = new Set(["and", "or", "not", "near"]);

/**
 * Parse a free-form user query into a valid FTS5 MATCH expression.
 *
 * Supported syntax (beyond a plain bag-of-words AND search):
 *   - "quoted phrases"    -> exact-phrase match (adjacency required)
 *   - word1 OR word2      -> either term matches (bare, unquoted, un-negated
 *                            "or" is the operator; a quoted "or" is a literal)
 *   - -word / -"phrase"   -> excludes results containing that term/phrase
 *
 * Every bare word becomes `(word OR word*)`: the unquoted term lets the porter
 * stemmer handle suffix variants ("crampons"→"crampon") while the `*` prefix
 * term handles partial words ("net"→"networking"). Bare words are AND'd unless
 * separated by OR. FTS5 special characters are stripped from bare words and
 * operator keywords are quoted, so arbitrary input can never produce an
 * invalid MATCH expression.
 *
 * Returns null for an empty/whitespace-only query.
 */
export function parseSearchQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Matches, in order of preference: an optionally-negated quoted phrase, or
  // an optionally-negated bare word (whitespace-delimited).
  const tokenRe = /(-)?"([^"]*)"|(-)?(\S+)/g;
  const positives: { expr: string; isOr: boolean }[] = [];
  const negatives: string[] = [];
  let pendingOr = false;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(trimmed)) !== null) {
    const quoted = m[2] !== undefined;
    const negated = !!(m[1] ?? m[3]);
    const text = quoted ? m[2]! : (m[4] as string);

    // Only a bare, unquoted, non-negated "or" is the OR operator - a quoted
    // "or" or a negated -or is a literal word to search for.
    if (!quoted && !negated && /^or$/i.test(text)) {
      pendingOr = true;
      continue;
    }

    if (quoted) {
      const phrase = text.trim();
      if (!phrase) continue;
      const term = `"${phrase.replace(/"/g, '""')}"`;
      if (negated) {
        negatives.push(term);
        pendingOr = false;
        continue;
      }
      positives.push({ expr: term, isOr: positives.length > 0 && pendingOr });
      pendingOr = false;
      continue;
    }

    const word = text.toLowerCase().replace(/["*^():]/g, "");
    if (!word) continue;

    // The unicode61 tokenizer splits on any non-alphanumeric character, so a
    // bare word like "linux-only" would otherwise become an invalid MATCH
    // expression ("no such column: only"). Split into sub-tokens and AND them
    // together; each gets the (stem OR prefix) expansion as usual.
    const subTokens = word.split(/[^a-z0-9]+/).filter(Boolean);
    if (subTokens.length === 0) continue;

    for (const sub of subTokens) {
      const safe = FTS_OPERATORS.has(sub) ? `"${sub}"` : sub;
      const term = `(${safe} OR ${sub}*)`;
      if (negated) {
        // FTS5 NOT is a binary "match A but not B" operator, not a unary
        // "-word" prefix, so negations are collected separately and subtracted
        // from the whole expression below.
        negatives.push(term);
        pendingOr = false;
        continue;
      }
      positives.push({ expr: term, isOr: positives.length > 0 && pendingOr });
      pendingOr = false;
    }
  }

  if (positives.length === 0) {
    // Every token was negated (e.g. a lone "-linux") - nothing positive to
    // anchor a NOT expression to in FTS5, so search the words literally.
    return negatives.length === 0 ? null : negatives.join(" AND ");
  }

  const posExpr = positives
    .map((p, i) => (i === 0 ? p.expr : `${p.isOr ? "OR" : "AND"} ${p.expr}`))
    .join(" ");
  if (negatives.length === 0) return posExpr;

  // Each positive term is already parenthesized; an AND/OR chain of several
  // needs an extra outer pair so the NOT can't bind to just the last term.
  const anchored = positives.length > 1 ? `(${posExpr})` : posExpr;
  return `${anchored} NOT (${negatives.join(" OR ")})`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Control-char markers passed to FTS5's snippet() as the highlight open/close
// strings. They are guaranteed to never be part of a unicode61 token, so page
// text can't inject a fake <mark> boundary (a real stored-XSS bug in the old
// app: snippet() output was rendered raw, and text containing "<mark>" or
// "<script>" reached the DOM as HTML).
const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

/**
 * Escape a raw FTS5 snippet for safe insertion into HTML. Page text is fully
 * escaped (a page body containing `<script>` must never emit as HTML), while
 * the highlight markers survive as real `<mark>` tags so the client can still
 * render them. Callers should treat the result as pre-escaped HTML and NOT run
 * it through dangerouslySetInnerHTML a second time with raw page text.
 */
export function escapeSnippet(raw: string): string {
  let html = "";
  let last = 0;
  const re = /[\u0001\u0002]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    html += escapeHtml(raw.slice(last, m.index));
    if (m[0] === MARK_OPEN) html += "<mark>";
    else if (m[0] === MARK_CLOSE) html += "</mark>";
    last = m.index + 1;
  }
  html += escapeHtml(raw.slice(last));
  return html;
}

/**
 * Search pages with optional space scoping, filtered to results the given
 * user can actually read. FTS5 has no concept of per-user permissions, so we
 * over-fetch candidate rows and run each through the same resolveAccess()
 * algorithm every other route uses, dropping any the user can't see - a
 * restricted page never appears in search results (title, snippet, or
 * otherwise) for someone who couldn't open it directly. Global admins skip
 * the per-row check entirely.
 */
export async function searchPages(
  rawQuery: string,
  user: UserContext,
  opts: { spaceId?: string; limit?: number } = {}
): Promise<SearchResult[]> {
  const ftsQuery = parseSearchQuery(rawQuery);
  if (!ftsQuery) return [];

  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  // Over-fetch since some candidates are dropped by the permission check
  // below; capped so a broad query against a large restricted wiki can't force
  // an unbounded number of branch-chain lookups.
  const candidateLimit = Math.min(limit * 5, 300);
  const spaceFilter = opts.spaceId ? "AND b.space_id = ?" : "";

  const { sqlite } = getDb();
  const stmt = sqlite.prepare(`
    SELECT f.page_id as pageId, b.id as branchId, p.slug,
           f.title as title,
           snippet(page_fts, 2, char(1), char(2), '…', 40) as rawSnippet,
           b.space_id as spaceId, s.name as spaceName
    FROM page_fts f
    JOIN pages p ON p.id = f.page_id AND p.deleted_at IS NULL
    JOIN branches b ON b.page_id = p.id AND b.is_system = 0
    JOIN spaces s ON s.id = b.space_id
    WHERE page_fts MATCH ? ${spaceFilter}
    ORDER BY rank
    LIMIT ?
  `);

  const params: unknown[] = [ftsQuery];
  if (opts.spaceId) params.push(opts.spaceId);
  params.push(candidateLimit);

  let candidates: (Omit<SearchResult, "snippet"> & { rawSnippet: string })[];
  try {
    candidates = stmt.all(...params) as (Omit<SearchResult, "snippet"> & { rawSnippet: string })[];
  } catch {
    // A query that parses to a malformed FTS5 expression (unbalanced quotes,
    // a bare operator with nothing on one side, etc.) throws at the SQLite
    // level rather than matching nothing - treat that as "no results" for the
    // caller instead of surfacing a 500 for what's really a bad query.
    return [];
  }

  if (user.isAdmin) {
    return candidates.slice(0, limit).map((c) => ({ ...c, snippet: escapeSnippet(c.rawSnippet) }));
  }

  const spaceRoleCache = new Map<string, SpaceRole | null>();
  const results: SearchResult[] = [];
  for (const c of candidates) {
    if (results.length >= limit) break;
    let role = spaceRoleCache.get(c.spaceId);
    if (role === undefined) {
      role = await resolveSpaceRole(user.id, c.spaceId, user.groupIds);
      spaceRoleCache.set(c.spaceId, role);
    }
    let chain: BranchContext[];
    try {
      chain = await getBranchChain(c.branchId);
    } catch {
      continue; // branch was deleted between the FTS snapshot and this check
    }
    if (resolveAccess(user, chain, role) !== "none") {
      results.push({ ...c, snippet: escapeSnippet(c.rawSnippet) });
    }
  }
  return results;
}

/**
 * Search spaces by name (case-insensitive substring), filtered the same way as
 * searchPages - a space the user has no read access to (no accessible branch)
 * never appears in results, so its existence and page count can't leak. Admins
 * skip the per-space check. Returns matches ordered exact-name-first, then by
 * shortest name (closest prefix wins).
 */
export async function searchSpaces(query: string, user: UserContext, limit = 5): Promise<SpaceSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const { sqlite } = getDb();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const stmt = sqlite.prepare(`
    SELECT s.id, s.name, COUNT(b.id) AS pageCount
    FROM spaces s
    LEFT JOIN branches b ON b.space_id = s.id AND b.is_system = 0
    LEFT JOIN pages p ON p.id = b.page_id AND p.deleted_at IS NULL
    WHERE s.name LIKE ? ESCAPE '\\'
    GROUP BY s.id
    ORDER BY CASE WHEN lower(s.name) = lower(?) THEN 0 ELSE 1 END, length(s.name), s.name
    LIMIT ?
  `);
  const candidates = stmt.all(like, q, limit) as SpaceSearchResult[];
  if (user.isAdmin) return candidates;

  const spaceRoleCache = new Map<string, SpaceRole | null>();
  const results: SpaceSearchResult[] = [];
  for (const s of candidates) {
    let role = spaceRoleCache.get(s.id);
    if (role === undefined) {
      role = await resolveSpaceRole(user.id, s.id, user.groupIds);
      spaceRoleCache.set(s.id, role);
    }
    const accessible = await accessibleBranchIds(user, s.id, role);
    if (accessible.size > 0) results.push(s);
  }
  return results;
}
