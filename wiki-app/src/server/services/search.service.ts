import { sqlite } from "../db/index.js";

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
 * Turn a free-form user query into an FTS5 MATCH expression.
 *
 * Handles the two shapes users actually type:
 *  - `"linux network code"`  → a phrase, matched verbatim (adjacency required)
 *  - `linux network code`    → each word becomes `(word OR word*)`
 *                              (porter-stemmed exact term for suffix variants
 *                              like "crampons"→"crampon", OR a prefix term for
 *                              partial matches like "net"→"networking")
 *
 * Words are AND'd together, so "linux network code" finds pages containing
 * all three concepts (near, but not necessarily adjacent). FTS5 special
 * characters are stripped from bare words and operator keywords are quoted.
 */
export function buildFtsQuery(raw: string): string {
  const groups: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      const phrase = m[1].trim();
      if (phrase) groups.push(`"${phrase.replace(/"/g, '""')}"`);
    } else if (m[2]) {
      const word = m[2].toLowerCase().replace(/["*^():]/g, "");
      if (!word) continue;
      const term = FTS_OPERATORS.has(word) ? `"${word}"` : word;
      groups.push(`(${term} OR ${word}*)`);
    }
  }
  return groups.join(" AND ");
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
 * Index or re-index a page in FTS5. Called after every page save.
 */
export function indexPage(pageId: string, title: string, content: unknown): void {
  const body = extractPlainText(content);
  sqlite.prepare("INSERT OR REPLACE INTO page_fts(rowid, page_id, title, body) VALUES (?, ?, ?, ?)").run(
    // Use a stable rowid derived from pageId so REPLACE works
    hashToRowid(pageId), pageId, title, body,
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
 * Search pages with optional space scoping. Returns results ordered by FTS rank.
 */
export function searchPages(query: string, spaceId?: string, limit = 20): SearchResult[] {
  if (!query.trim()) return [];

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  const spaceFilter = spaceId ? "AND b.space_id = ?" : "";

  const stmt = sqlite.prepare(`
    SELECT f.page_id, b.id as branchId, p.slug,
           f.title as title,
           snippet(page_fts, 2, '<mark>', '</mark>', '…', 40) as snippet,
           b.space_id as spaceId,
           s.name as spaceName
    FROM page_fts f
    JOIN pages p ON p.id = f.page_id
    JOIN branches b ON b.page_id = p.id
    JOIN spaces s ON s.id = b.space_id
    WHERE page_fts MATCH ? ${spaceFilter}
    ORDER BY rank
    LIMIT ?
  `);

  const params: unknown[] = [ftsQuery];
  if (spaceId) params.push(spaceId);
  params.push(limit);

  return stmt.all(...params) as SearchResult[];
}

/**
 * Search spaces by name (case-insensitive substring). Returns matches ordered
 * exact-name-first, then by shortest name (closest prefix wins).
 */
export function searchSpaces(query: string, limit = 5): SpaceSearchResult[] {
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
  return stmt.all(like, q, limit) as SpaceSearchResult[];
}

function hashToRowid(id: string): number {
  // Simple hash to produce a stable positive integer from a UUID
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}
