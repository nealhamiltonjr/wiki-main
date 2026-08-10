import { eq, and, lte } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { jobQueue } from "../db/schema.js";
import { commitPageChange, commitManualSnapshot } from "./git.service.js";

const POLL_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 5;

/**
 * Minimal DB-backed job queue (brief §8 step 10 — the "commit queue"). Page
 * saves enqueue `git_commit` jobs; the worker loop (started from index.ts)
 * drains them so an HTTP response is never blocked by a git operation.
 * Retry/backoff: a failed job goes back to pending with exponential backoff,
 * capped at 5 attempts before it's marked failed.
 */
export async function enqueueJob(kind: string, payload: unknown, runAfter?: Date) {
  const { db } = getDb();
  await db.insert(jobQueue).values({
    id: crypto.randomUUID(),
    kind,
    payload: payload as never,
    status: "pending",
    runAfter: runAfter ?? new Date(),
  });
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
}

async function runJob(kind: string, payload: unknown) {
  switch (kind) {
    case "git_commit": {
      const p = payload as GitCommitPayload;
      if (p.kind === "manual_snapshot") {
        await commitManualSnapshot(p.pageId, p.message ?? "", p.userId ?? "unknown");
      } else {
        await commitPageChange(p.pageId, p.branchId);
      }
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
export function startWorkerLoop() {
  setInterval(() => {
    if (workerRunning) return;
    workerRunning = true;
    processPendingJobs()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[queue] worker loop error", err);
      })
      .finally(() => {
        workerRunning = false;
      });
  }, POLL_INTERVAL_MS);
}
