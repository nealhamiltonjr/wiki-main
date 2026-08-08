import { getDb } from "../db/index.js";

interface PMNode {
  type: string;
  content?: PMNode[];
  text?: string;
  attrs?: Record<string, unknown>;
}

/** Concatenates all plain text from a Tiptap/ProseMirror JSON doc. */
export function docToText(doc: unknown): string {
  const json = (typeof doc === "string" ? JSON.parse(doc) : doc) as PMNode | null;
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
