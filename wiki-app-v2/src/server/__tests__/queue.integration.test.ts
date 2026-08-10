import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";

const DB_PATH = `data/test-queue-${randomBytes(4).toString("hex")}.db`;
process.env.DB_PATH = DB_PATH;

import { enqueueJob, processPendingJobs, reclaimStaleJobs } from "../services/queue.service.js";
import { getDb, closeDb } from "../db/index.js";
import { jobQueue } from "../db/schema.js";

beforeAll(() => {
  const root = process.cwd();
  if (!existsSync(`${root}/data`)) mkdirSync(`${root}/data`, { recursive: true });
  getDb(); // force migration so the job_queue table exists
});

afterAll(() => {
  closeDb();
  rmSync(DB_PATH, { recursive: true, force: true });
});

/** Rewind a job's runAfter to the past so it becomes due again. */
async function makeDue(id: string) {
  const { db } = getDb();
  await db.update(jobQueue).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobQueue.id, id));
}

describe("commit queue (slice-10)", () => {
  it("retries a failing job with exponential backoff and marks it failed at MAX_ATTEMPTS", async () => {
    const id = await enqueueJob("no_such_kind", {});
    const { db } = getDb();

    // Attempt 1: runJob throws "Unknown job kind" → back to pending, attempts 1,
    // runAfter pushed to ~now+2s. (processPendingJobs counts only successes, so
    // the failing drain returns 0 — assert on the row, not the return value.)
    expect(await processPendingJobs()).toBe(0);
    let [job] = await db.select().from(jobQueue).where(eq(jobQueue.id, id));
    expect(job!.status).toBe("pending");
    expect(job!.attempts).toBe(1);
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now());

    // Not due yet — the next drain leaves it alone.
    expect(await processPendingJobs()).toBe(0);
    [job] = await db.select().from(jobQueue).where(eq(jobQueue.id, id));
    expect(job!.attempts).toBe(1);

    // Force due and drain repeatedly up to the max.
    for (let attempt = 2; attempt <= 5; attempt++) {
      await makeDue(id);
      await processPendingJobs();
      [job] = await db.select().from(jobQueue).where(eq(jobQueue.id, id));
      expect(job!.attempts).toBe(attempt);
    }
    expect(job!.status).toBe("failed");

    // Failed jobs are never picked up again.
    await makeDue(id);
    await processPendingJobs();
    [job] = await db.select().from(jobQueue).where(eq(jobQueue.id, id));
    expect(job!.attempts).toBe(5);
    expect(job!.status).toBe("failed");
  });

  it("leaves a job scheduled in the future alone and skips running jobs", async () => {
    const { db } = getDb();
    const futureId = await enqueueJob("no_such_kind", {}, new Date(Date.now() + 60_000));
    const runningId = await enqueueJob("no_such_kind", {});
    await db.update(jobQueue).set({ status: "running" }).where(eq(jobQueue.id, runningId));

    expect(await processPendingJobs()).toBe(0);
    const [future] = await db.select().from(jobQueue).where(eq(jobQueue.id, futureId));
    const [running] = await db.select().from(jobQueue).where(eq(jobQueue.id, runningId));
    expect(future!.status).toBe("pending");
    expect(running!.status).toBe("running");

    // Clean up so later tests start from a blank slate (the running job would
    // otherwise be reclaimed as stale by the crash-recovery test).
    await db.update(jobQueue).set({ status: "failed" }).where(eq(jobQueue.id, runningId));
  });

  it("reclaims jobs stranded in running (crash recovery) so they are retried", async () => {
    const { db } = getDb();
    const id = await enqueueJob("no_such_kind", {});
    // Simulate a crash mid-drain: the row is left `running` forever.
    await db.update(jobQueue).set({ status: "running" }).where(eq(jobQueue.id, id));

    expect(await reclaimStaleJobs()).toBe(1);
    const [job] = await db.select().from(jobQueue).where(eq(jobQueue.id, id));
    expect(job!.status).toBe("pending");

    // A second call has nothing left to reclaim.
    expect(await reclaimStaleJobs()).toBe(0);

    // Clean up so the reclaimed job doesn't consume the 10-per-pass budget
    // of the batching test below.
    await db.update(jobQueue).set({ status: "failed" }).where(eq(jobQueue.id, id));
  });

  it("drains at most 10 jobs per pass (single-threaded worker guard)", async () => {
    const ids = await Promise.all(
      Array.from({ length: 15 }, () => enqueueJob("no_such_kind", {})),
    );
    await processPendingJobs();
    const { db } = getDb();
    // The first pass claimed exactly 10 of the 15 (attempts 1); the other 5
    // were never touched (attempts 0) and stay pending for the next poll.
    const rows = await db.select().from(jobQueue).where(inArray(jobQueue.id, ids));
    const tried = rows.filter((r) => r.attempts === 1);
    const untouched = rows.filter((r) => r.attempts === 0);
    expect(tried.length).toBe(10);
    expect(untouched.length).toBe(5);
    expect(ids[0]).toBeTypeOf("string");
  });
});
