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
// Deferred to initFts() so drizzle-kit push (which reads the DB) doesn't
// trip over the SQLite-internal shadow tables (page_fts_data etc.).
// ---------------------------------------------------------------------------
export function initFts() {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
      page_id UNINDEXED,
      title,
      body,
      tokenize='porter unicode61'
    )
  `);
}

// ---------------------------------------------------------------------------
// Apply pending schema migrations that drizzle-kit can't handle declaratively.
// Called from server startup after drizzle push.
// ---------------------------------------------------------------------------
export function applyMigrations() {
  // Add `suspended` column to user table if it doesn't exist yet.
  const userCols = sqlite.pragma("table_info(user)") as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === "suspended")) {
    sqlite.exec(`ALTER TABLE "user" ADD COLUMN "suspended" integer DEFAULT 0`);
  }

  // Add `default_role` to spaces table.
  const spaceCols = sqlite.pragma("table_info(spaces)") as Array<{ name: string }>;
  if (!spaceCols.some((c) => c.name === "default_role")) {
    sqlite.exec(`ALTER TABLE "spaces" ADD COLUMN "default_role" text DEFAULT 'none'`);
  }

  // Add `capabilities` to groups table.
  const groupCols = sqlite.pragma("table_info(groups)") as Array<{ name: string }>;
  if (!groupCols.some((c) => c.name === "capabilities")) {
    sqlite.exec(`ALTER TABLE "groups" ADD COLUMN "capabilities" text DEFAULT '[]'`);
  }
}
