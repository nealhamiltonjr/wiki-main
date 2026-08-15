import { eq, and, lte } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { jobQueue, systemSettings } from "../db/schema.js";
import { commitPageChange, commitManualSnapshot, commitDatabaseSnapshot, listSnapshots } from "./git.service.js";

const POLL_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 5;

/**
 * Minimal DB-backed job queue (brief §8 step 10 — the "commit queue"). Page
 * saves enqueue `git_commit` jobs; the worker loop (started from index.ts)
 * drains them so an HTTP response is never blocked by a git operation.
 * Retry/backoff: a failed job goes back to pending with exponential backoff,
 * capped at 5 attempts before it's marked failed.
 */
export async function enqueueJob(kind: string, payload: unknown, runAfter?: Date): Promise<string> {
  const { db } = getDb();
  const id = crypto.randomUUID();
  await db.insert(jobQueue).values({
    id,
    kind,
    payload: payload as never,
    status: "pending",
    runAfter: runAfter ?? new Date(),
  });
  return id;
}

/**
 * Resets jobs stranded in `running` back to pending so they're retried. A
 * crash mid-drain leaves the row `running` forever — nothing else would ever
 * pick it up. Called once at worker startup; exported for tests.
 */
export async function reclaimStaleJobs(): Promise<number> {
  const { db } = getDb();
  const result = await db.update(jobQueue).set({ status: "pending" }).where(eq(jobQueue.status, "running"));
  return (result as unknown as { changes: number }).changes ?? 0;
}

/** Processes due pending jobs. Exported for tests; the loop calls it repeatedly. */
export async function processPendingJobs(): Promise<number> {
  const { db } = getDb();
  const now = new Date();
  const jobs = await db
    .select()
    .from(jobQueue)
    .where(and(eq(jobQueue.status, "pending"), lte(jobQueue.runAfter, now)))
    .limit(10);

  let processed = 0;
  for (const job of jobs) {
    await db.update(jobQueue).set({ status: "running" }).where(eq(jobQueue.id, job.id));
    try {
      await runJob(job.kind, job.payload as never);
      await db.update(jobQueue).set({ status: "done" }).where(eq(jobQueue.id, job.id));
      processed++;
    } catch (err) {
      const attempts = job.attempts + 1;
      await db
        .update(jobQueue)
        .set({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          runAfter: new Date(Date.now() + Math.min(2 ** attempts * 1000, 60_000)), // backoff, capped at 60s
        })
        .where(eq(jobQueue.id, job.id));
      // eslint-disable-next-line no-console
      console.warn(`[queue] job ${job.id} (${job.kind}) failed`, String(err));
    }
  }
  return processed;
}

interface GitCommitPayload {
  kind?: "autosave" | "manual_snapshot";
  pageId: string;
  branchId: string;
  message?: string;
  userId?: string;
  /** Previous slug at rename time, so the commit can drop the old file. */
  oldSlug?: string;
}

async function runJob(kind: string, payload: unknown) {
  switch (kind) {
    case "git_commit": {
      const p = payload as GitCommitPayload;
      if (p.kind === "manual_snapshot") {
        await commitManualSnapshot(p.pageId, p.message ?? "", p.userId ?? "unknown");
      } else {
        await commitPageChange(p.pageId, p.branchId, p.oldSlug);
      }
      return;
    }
    case "git_db_snapshot": {
      const p = payload as { trigger: "manual" | "scheduled"; message?: string; userId?: string };
      await commitDatabaseSnapshot({ trigger: p.trigger, message: p.message, userId: p.userId });
      return;
    }
    default:
      throw new Error(`Unknown job kind: ${kind}`);
  }
}

/**
 * Infinite poll loop — started once from index.ts (never from buildApp, so
 * tests stay timer-free). The `running` guard prevents poll overlap: git
 * operations are not serialized by simple-git, so two overlapping drains could
 * race on `.git/index.lock` or fold one page's staged file into another page's
 * commit.
 */
let workerRunning = false;
let lastSnapshotCheck = 0;
let lastScheduledSnapshotAt = 0;

/** Reads the snapshot schedule settings and enqueues a `git_db_snapshot` job
 *  when the interval has elapsed. Throttled to once per 60s to avoid a git log
 *  call on every 1s worker tick. Smart trigger (only snap if dirty) is honored
 *  by checking the repo dirty count before enqueueing. */
async function maybeScheduleSnapshot(): Promise<void> {
  const now = Date.now();
  if (now - lastSnapshotCheck < 60_000) return;
  lastSnapshotCheck = now;

  try {
    const { db } = getDb();
    const rows = await db.select().from(systemSettings);
    const valueOf = <T>(key: string, def: T): T => {
      const r = rows.find((x) => x.key === key);
      return (r?.value ?? def) as T;
    };
    if (valueOf("snapshot.enabled", true) !== true) return;

    const intervalHours = Number(valueOf("snapshot.intervalHours", 6));
    const hours = Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 6;
    const intervalMs = hours * 60 * 60 * 1000;

    if (lastScheduledSnapshotAt === 0) {
      const recent = await listSnapshots(1);
      lastScheduledSnapshotAt = recent[0] ? new Date(recent[0].date).getTime() : 0;
    }

    if (now - lastScheduledSnapshotAt < intervalMs) return;

    // Smart trigger: only snap if the repo is dirty (default ON).
    if (valueOf("snapshot.smartTrigger", true) === true) {
      const { getRepoStatus } = await import("./git.service.js");
      const status = await getRepoStatus().catch(() => null);
      const minChanges = Number(valueOf("snapshot.minChanges", 1)) || 1;
      if ((status?.dirty ?? 0) < minChanges) return;
    }

    await enqueueJob("git_db_snapshot", { trigger: "scheduled" });
    lastScheduledSnapshotAt = now;
  } catch (err) {
    console.error("[queue] maybeScheduleSnapshot failed", err);
  }
}

export function startWorkerLoop() {
  // Retry anything a previous process left mid-flight (crash, deploy, test
  // teardown) before the poll loop starts claiming new work.
  reclaimStaleJobs().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[queue] reclaimStaleJobs failed", err);
  });
  setInterval(() => {
    if (workerRunning) return;
    workerRunning = true;
    Promise.resolve()
      .then(() => maybeScheduleSnapshot())
      .then(() => processPendingJobs())
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[queue] worker loop error", err);
      })
      .finally(() => {
        workerRunning = false;
      });
  }, POLL_INTERVAL_MS);
}
