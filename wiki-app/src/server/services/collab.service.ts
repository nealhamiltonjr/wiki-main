import { Hocuspocus } from "@hocuspocus/server";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";
import BetterSqlite3 from "better-sqlite3";
import { log } from "./log.service.js";

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

export const hocuspocus = new Hocuspocus({
  name: "wiki-collab",
  timeout: 30000,
  debounce: 2000,
  maxDebounce: 10000,

  async onAuthenticate({ token }) {
    if (!token) throw new Error("Authentication required");
  },

  async onLoadDocument({ documentName }) {
    let doc = docs.get(documentName);
    if (doc) return doc;

    doc = new Doc();
    const stored = loadFromDb(documentName);
    if (stored) {
      applyUpdate(doc, stored);
      log("info", "collab", `Loaded document ${documentName} from DB`);
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

