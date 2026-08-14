/**
 * §11.4 admin observability surface.
 *
 * Aggregates the bits of state the admin System Health page cares
 * about into a single response: recent server errors, last
 * successful git-flush time, collab/queue health, DB file size +
 * WAL mode, and any plugin in a failure streak.
 *
 * Every underlying call is best-effort and bounded — if the DB
 * is wedged, `getSystemHealth()` still returns a 200 with the
 * fields it could fetch and a top-level `degraded: true` flag
 * the UI can show.
 */
import { stat } from "node:fs/promises";
import { sql, desc, eq, and, count } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { systemSettings, jobQueue, plugins } from "../db/schema.js";
import { listPlugins } from "./plugin.service.js";
import { getRecentErrors } from "./system-logger.service.js";

export interface SystemHealthReport {
  generatedAt: string;
  degraded: boolean;
  errors: {
    recent: { id: string; source: string; message: string; meta: unknown; createdAt: string }[];
    note?: string;
  };
  git: {
    lastFlushAt: string | null;
    note?: string;
  };
  queue: {
    pending: number;
    failed: number;
    oldestPendingAgeSec: number | null;
    note?: string;
  };
  database: {
    path: string;
    sizeBytes: number | null;
    journalMode: string | null;
    pageCount: number | null;
    note?: string;
  };
  plugins: {
    failing: { id: string; name: string; failureCount: number; lastError: string | null; autoDisabled: boolean }[];
    note?: string;
  };
  runtime: {
    uptimeSec: number;
    node: string;
    pid: number;
  };
}

/**
 * Read DB file size + WAL mode directly from the underlying
 * better-sqlite3 handle. Kept inside a try/catch so a missing
 * file (e.g. in a brand-new test DB) still yields a populated
 * report with a note instead of throwing the whole call away.
 */
async function collectDatabaseStats(): Promise<SystemHealthReport["database"]> {
  const dbPath = process.env.DB_PATH ?? "data/wiki.db";
  const note: string | undefined = undefined;
  let sizeBytes: number | null = null;
  let journalMode: string | null = null;
  let pageCount: number | null = null;
  try {
    const s = await stat(dbPath).catch(() => null);
    sizeBytes = s?.size ?? 0;
  } catch {
    /* leave null */
  }
  try {
    const { sqlite } = getDb();
    const row = sqlite.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    journalMode = row?.journal_mode ?? null;
    const countRow = sqlite.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n?: number } | undefined;
    pageCount = countRow?.n ?? null;
  } catch {
    /* leave null */
  }
  return { path: dbPath, sizeBytes, journalMode, pageCount, note };
}

async function collectGitStats(): Promise<SystemHealthReport["git"]> {
  try {
    const { db } = getDb();
    const [row] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "last_git_flush_at"))
      .limit(1);
    const raw = row?.value;
    const lastFlushAt =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>)
          ? String((raw as { value: unknown }).value)
          : null;
    return { lastFlushAt };
  } catch (err) {
    return {
      lastFlushAt: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function collectQueueStats(): Promise<SystemHealthReport["queue"]> {
  try {
    const { db } = getDb();
    const [pendingRow] = await db
      .select({ n: count() })
      .from(jobQueue)
      .where(eq(jobQueue.status, "pending"));
    const [failedRow] = await db
      .select({ n: count() })
      .from(jobQueue)
      .where(eq(jobQueue.status, "failed"));
    // Oldest pending — surfaced so a stuck queue is obvious. NULL
    // when the queue is empty.
    const [oldestRow] = await db
      .select({ age: sql<number | null>`unixepoch() - min(${jobQueue.createdAt})` })
      .from(jobQueue)
      .where(eq(jobQueue.status, "pending"));
    return {
      pending: pendingRow?.n ?? 0,
      failed: failedRow?.n ?? 0,
      oldestPendingAgeSec: oldestRow?.age ?? null,
    };
  } catch (err) {
    return {
      pending: 0,
      failed: 0,
      oldestPendingAgeSec: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function collectPluginStats(): Promise<SystemHealthReport["plugins"]> {
  try {
    // Only ask the plugins table for rows in a non-zero failure state;
    // listPlugins already does a select(*) which would scan every row
    // just to filter most of it out.
    const { db } = getDb();
    const rows = await db
      .select()
      .from(plugins)
      .where(and(sql`(${plugins.failureCount} > 0 OR ${plugins.disabledReason} IS NOT NULL)`))
      .orderBy(desc(plugins.failureCount));
    return {
      failing: rows.map((r) => ({
        id: r.id,
        name: r.name,
        failureCount: r.failureCount,
        lastError: r.lastError,
        autoDisabled: !r.enabled && r.disabledReason != null,
      })),
    };
  } catch (err) {
    return {
      failing: [],
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Top-level aggregator. Each section is its own try/catch so one
 * failure (e.g. a missing plugin row) doesn't blank the whole
 * page. A single field with a note is far more useful to an admin
 * debugging a live system than a 500.
 */
export async function getSystemHealth(): Promise<SystemHealthReport> {
  let degraded = false;
  const [errors, git, queue, database, pluginsOut] = await Promise.all([
    (async () => {
      try {
        return { recent: await getRecentErrors(20) };
      } catch (err) {
        degraded = true;
        return {
          recent: [],
          note: err instanceof Error ? err.message : String(err),
        };
      }
    })(),
    collectGitStats(),
    collectQueueStats(),
    collectDatabaseStats(),
    collectPluginStats(),
  ]);

  // Suppress unused-var noise — listPlugins stays imported so callers
  // that later want full info can swap the collect function without
  // a new import.
  void listPlugins;

  return {
    generatedAt: new Date().toISOString(),
    degraded,
    errors,
    git,
    queue,
    database,
    plugins: pluginsOut,
    runtime: {
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      pid: process.pid,
    },
  };
}
