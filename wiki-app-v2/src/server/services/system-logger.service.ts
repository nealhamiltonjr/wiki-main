/**
 * System event logger — §11.4 observability.
 *
 * The system_logs table already exists in the schema (brief §3.16)
 * but nothing was writing to it. This service is the single funnel:
 * the Fastify error handler, plugin failures (slice-34 hooks), and
 * one-off server-side events all funnel through `recordSystemLog`
 * so the admin System Health page can show "last 20 errors" with
 * a single query.
 *
 * Deliberately NOT a logger replacement: Fastify's pino-based
 * structured logger is still the source of truth for the request
 * path; this module persists a compact summary row for the admin
 * UI and only ever blocks on the (tiny, indexed) DB write.
 */
import { getDb } from "../db/index.js";
import { systemLogs } from "../db/schema.js";
import { desc, eq, and, gte, sql } from "drizzle-orm";

export type SystemLogLevel = "debug" | "info" | "warn" | "error";

export interface SystemLogInput {
  level: SystemLogLevel;
  source: string;
  message: string;
  meta?: unknown;
}

/**
 * Insert a row. Errors are caught and logged via console.error so
 * the persistence layer never crashes the caller — losing a single
 * log line is acceptable; losing the request is not.
 */
export async function recordSystemLog(input: SystemLogInput): Promise<void> {
  try {
    const { db } = getDb();
    await db.insert(systemLogs).values({
      level: input.level,
      source: input.source,
      message: input.message.slice(0, 1000),
      meta: input.meta === undefined ? null : (input.meta as Record<string, unknown>),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[system-logger] failed to persist log row:`, err);
  }
}

/**
 * Last N errors ordered newest-first. Bounded so a runaway loop
 * can't dump the whole table to the admin UI; the limit is small
 * enough to fit one round trip and one paint.
 */
export async function getRecentErrors(limit = 20): Promise<{
  id: string;
  level: SystemLogLevel;
  source: string;
  message: string;
  meta: unknown;
  createdAt: string;
}[]> {
  const { db } = getDb();
  const rows = await db
    .select({
      id: systemLogs.id,
      level: systemLogs.level,
      source: systemLogs.source,
      message: systemLogs.message,
      meta: systemLogs.meta,
      createdAt: systemLogs.createdAt,
    })
    .from(systemLogs)
    .where(eq(systemLogs.level, "error"))
    .orderBy(desc(systemLogs.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    level: r.level as SystemLogLevel,
    source: r.source,
    message: r.message,
    meta: r.meta,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Count of errors since a cutoff. Useful for "errors in the last
 * hour" badges without shipping the whole list.
 */
export async function countErrorsSince(since: Date): Promise<number> {
  const { db } = getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(systemLogs)
    .where(and(eq(systemLogs.level, "error"), gte(systemLogs.createdAt, since)));
  return rows[0]?.n ?? 0;
}
