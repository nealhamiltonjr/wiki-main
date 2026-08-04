import { sqlite } from "../db/index.js";
import { getBranchChain, resolveSpaceRole, accessibleBranchIds } from "./branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { BranchContext, SpaceRole, UserContext } from "../../shared/types.js";

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

/**
 * Extract plain text from Tiptap JSON for FTS indexing.
 */
export function extractPlainText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const parts: string[] = [];
  const stack = [doc as Record<string, unknown>];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "text" && typeof node.text === "string") {
      parts.push(node.text);
    }
    const content = node.content as unknown[] | undefined;
    if (content) {
      for (let i = content.length - 1; i >= 0; i--) {
        stack.push(content[i] as Record<string, unknown>);
      }
    }
  }
  return parts.join(" ");
}

/**
 * Index or re-index a page in FTS5. Called after every page save. The FTS
 * title falls back to the page slug when the document has no H1, so a page is
 * always findable by its slug even before any body text exists.
 */
export function indexPage(pageId: string, title: string, content: unknown, slug?: string): void {
  const body = extractPlainText(content);
  const ftsTitle = title || slug || "";
  sqlite.prepare("INSERT OR REPLACE INTO page_fts(rowid, page_id, title, body) VALUES (?, ?, ?, ?)").run(
    // Use a stable rowid derived from pageId so REPLACE works
    hashToRowid(pageId), pageId, ftsTitle, body,
  );
}

/**
 * Extract the first H1 text from Tiptap JSON for use as the FTS title.
 */
export function extractTitle(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const d = doc as Record<string, unknown>;
  const content = d.content as unknown[] | undefined;
  if (!content) return "";
  for (const node of content) {
    const n = node as Record<string, unknown>;
    if (n.type === "heading" && n.attrs && (n.attrs as Record<string, unknown>).level === 1) {
      return extractPlainText(n);
    }
  }
  return "";
}

/**
 * Search pages with optional space scoping, filtered to results the given
 * user can actually read. FTS5 has no concept of per-user permissions, so we
 * over-fetch candidate rows and run each through the same resolveAccess()
 * algorithm every other route uses, dropping any the user can't see - a
 * restricted page never appears in search results (title, snippet, or
 * otherwise) for someone who couldn't open it directly. Global admins skip
 * the per-row check entirely (resolveAccess would grant them everything
 * anyway; skipping avoids the branch-chain lookups).
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

  const stmt = sqlite.prepare(`
    SELECT f.page_id as pageId, b.id as branchId, p.slug,
           f.title as title,
           snippet(page_fts, 2, '<mark>', '</mark>', '…', 40) as snippet,
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

  let candidates: SearchResult[];
  try {
    candidates = stmt.all(...params) as SearchResult[];
  } catch {
    // A query that parses to a malformed FTS5 expression (unbalanced quotes,
    // a bare operator with nothing on one side, etc.) throws at the SQLite
    // level rather than matching nothing - treat that as "no results" for the
    // caller instead of surfacing a 500 for what's really a bad query.
    return [];
  }

  if (user.isAdmin) return candidates.slice(0, limit);

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
      results.push(c);
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

function hashToRowid(id: string): number {
  // Simple hash to produce a stable positive integer from a UUID
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}
