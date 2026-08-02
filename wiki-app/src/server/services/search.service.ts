import { sqlite } from "../db/index.js";
import { db } from "../db/index.js";
import { pages, branches } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";

export interface SearchResult {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  snippet: string;
  spaceId: string;
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

  const ftsQuery = query.trim().split(/\s+/).map(w => `"${w.replace(/"/g, '""')}"`).join(" AND ");
  const spaceFilter = spaceId ? "AND b.space_id = ?" : "";

  const stmt = sqlite.prepare(`
    SELECT f.page_id, b.id as branchId, p.slug,
           f.title as title,
           snippet(page_fts, 2, '<mark>', '</mark>', '…', 40) as snippet,
           b.space_id as spaceId
    FROM page_fts f
    JOIN pages p ON p.id = f.page_id
    JOIN branches b ON b.page_id = p.id
    WHERE page_fts MATCH ? ${spaceFilter}
    ORDER BY rank
    LIMIT ?
  `);

  const params: unknown[] = [ftsQuery];
  if (spaceId) params.push(spaceId);
  params.push(limit);

  return stmt.all(...params) as SearchResult[];
}

function hashToRowid(id: string): number {
  // Simple hash to produce a stable positive integer from a UUID
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}
