import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as authSchema from "./auth-schema.js";
import * as wikiSchema from "./schema.js";
import { assertSafeRegex } from "../utils/regex-safety.js";

// ---------------------------------------------------------------------------
// THE single SQLite connection (brief §3.2). Every service — collab included —
// must import `db`/`sqlite` from this module. No second `new Database(...)`
// anywhere else. Initialization is lazy so tests can point DB_PATH at an
// isolated file before the first import chain resolves.
// ---------------------------------------------------------------------------

let state: { db: Db; sqlite: Database.Database; dbPath: string } | undefined;

/** Resolve the SQLite database file path the singleton uses. Exported so the
 *  git snapshot/restore services can copy/restore the same file. */
export function getDbPath(): string {
  const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const rawPath = process.env.DB_PATH ?? "data/wiki.db";
  return resolve(projectRoot, rawPath);
}

export function getDb() {
  if (state) return state;

  // src/server/db/ -> wiki-app-v2 root (3 hops, verified against resolve()).
  const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const dbPath = getDbPath();

  mkdirSync(resolve(projectRoot, "data"), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON"); // SQLite doesn't enforce FKs by default — turn it on explicitly

  // Flat schema object keyed by table name — NEVER a namespace import wrapped
  // in braces: Vite SSR gives namespace imports a null prototype, which trips
  // drizzle's `is()` table detection (instanceof short-circuits for the
  // individual tables inside a flat object, so spreading avoids it).
  // Combines the better-auth identity tables with the wiki tables; both are
  // spread so every table (user, users, session, groups, spaces, pages, ...)
  // is reachable on the single drizzle instance.
  const db = drizzle(sqlite, { schema: { ...authSchema, ...wikiSchema } });

  // Apply committed schema migrations in order (drizzle/). Idempotent — the
  // migrator tracks applied versions in __drizzle_migrations.
  migrate(db, { migrationsFolder: resolve(projectRoot, "drizzle") });

  // FTS5 search index (§7.12d.2). External-content FTS keeps the text in the
  // pages table and mirrors it here on every save via search.service.ts.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
      page_id UNINDEXED,
      title,
      body,
      tokenize='porter unicode61'
    )
  `);

  // SQLite ships without a REGEXP function unless you register one. Lenses
  // (brief §12.4) match pages by regex-over-title, so register a thin
  // JS-side implementation. Slice-42: the pattern is no longer trusted —
  // a malicious lens owner could persist a catastrophic-backtracking
  // pattern and freeze the server on every results call. Re-check the
  // pattern's complexity on every invocation (cheap) and refuse to
  // execute an unsafe one. The route and the service also gate the same
  // pattern at write time and at runLens entry; this is the last line of
  // defense so any legacy row written before those gates cannot DoS us.
  sqlite.function("regexp", { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (typeof pattern !== "string" || typeof value !== "string") return 0;
    const safety = assertSafeRegex(pattern);
    if (!safety.safe) throw new Error(`unsafe regex pattern: ${safety.reason ?? "rejected"}`);
    try {
      return new RegExp(pattern).test(value) ? 1 : 0;
    } catch {
      throw new Error(`invalid regex pattern: ${pattern}`);
    }
  });

  // Slice 35 — debug capture: wrap `prepare` so every SQLite statement
  // execution can be observed (while debug capture is enabled). Drizzle
  // creates statements via prepare and calls .run/.get/.all/.iterate on them.
  // The wrapper is a pass-through that only adds timing when the debug
  // capture ring is enabled (checked inside recordDbCall), so the overhead is
  // a single boolean branch per statement call.
  const originalPrepare = sqlite.prepare.bind(sqlite);
  (sqlite as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = originalPrepare(sql) as {
      run: (...args: unknown[]) => unknown;
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown;
      iterate: (...args: unknown[]) => unknown;
    };
    const time = (fn: () => unknown) => {
      const start = performance.now();
      let err: unknown;
      try {
        return fn();
      } catch (e) {
        err = e;
        throw e;
      } finally {
        void import("../services/debug-capture.service.js").then((m) =>
          m.recordDbCall(sql, performance.now() - start, err),
        );
      }
    };
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        if (prop === "run" || prop === "get" || prop === "all" || prop === "iterate") {
          return (...args: unknown[]) => time(() => value.apply(target, args));
        }
        return value.bind(target);
      },
    });
  };

  state = { db, sqlite, dbPath };
  return state;
}

export type Db = ReturnType<typeof drizzle<typeof authSchema & typeof wikiSchema>>;

/** Reset the singleton — only for tests that need a fresh DB after another test
 *  file has already initialized one. Vitest runs sequentially so the module
 *  state leaks across files. */
export function closeDb() {
  if (state) {
    state.sqlite.close();
    state = undefined;
  }
}
