import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const sqlite = new Database(process.env.DB_PATH ?? "./data/wiki.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON"); // SQLite doesn't enforce FKs by default - turn it on explicitly

export const db = drizzle(sqlite, { schema });
export { sqlite };

// ---------------------------------------------------------------------------
// FTS5 full-text search — virtual table (§7.12d.2)
// Created at module load so it's always available, even in tests.
// ---------------------------------------------------------------------------
sqlite.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
    page_id UNINDEXED,
    title,
    body,
    tokenize='porter unicode61'
  )
`);
