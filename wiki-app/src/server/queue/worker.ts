import { eq, and, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { jobQueue } from "../db/schema.js";
import { users } from "../db/schema.js";
import { commitPageChange, commitManualSnapshot, pushToRemote, pullFromRemote } from "../services/git.service.js";
import { runShareLinkWatchdog } from "../services/token.service.js";
import { sendShareLinkWarning } from "../services/mailer.service.js";
import { log } from "../services/log.service.js";

const POLL_INTERVAL_MS = 1000;
const WATCHDOG_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for a 30-day inactivity threshold
const MAX_ATTEMPTS = 5;

export async function runWorkerLoop() {
  let lastWatchdogRun = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await processNextBatch();

    if (Date.now() - lastWatchdogRun > WATCHDOG_INTERVAL_MS) {
      lastWatchdogRun = Date.now();
      await runShareLinkWatchdog(async (tokenId, createdBy, warningCount) => {
        const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, createdBy));
        if (user?.email) {
          await sendShareLinkWarning(user.email, tokenId, warningCount, tokenId);
        } else {
          log("warn", "watchdog", `share link ${tokenId}: no email for owner ${createdBy}, warning ${warningCount}/3`);
        }
      });
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function processNextBatch() {
  const now = new Date();
  const jobs = await db
    .select()
    .from(jobQueue)
    .where(and(eq(jobQueue.status, "pending"), lte(jobQueue.runAfter, now)))
    .limit(10);

  for (const job of jobs) {
    await db.update(jobQueue).set({ status: "running" }).where(eq(jobQueue.id, job.id));
    try {
      await runJob(job.kind, job.payload as any);
      await db.update(jobQueue).set({ status: "done" }).where(eq(jobQueue.id, job.id));
    } catch (err) {
      const attempts = job.attempts + 1;
      log("error", "worker", `job ${job.id} (${job.kind}) failed`, { error: String(err), attempts });
      await db
        .update(jobQueue)
        .set({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          runAfter: new Date(Date.now() + Math.min(2 ** attempts * 1000, 60_000)), // backoff, capped at 60s
        })
        .where(eq(jobQueue.id, job.id));
    }
  }
}

async function runJob(kind: string, payload: any) {
  switch (kind) {
    case "git_commit":
      if (payload.kind === "manual_snapshot") {
        await commitManualSnapshot(payload.pageId, payload.message, payload.userId);
      } else {
        await commitPageChange(payload.pageId, payload.branchId);
      }
      return;
    case "git_push":
      await pushToRemote({ force: payload.force === true });
      return;
    case "git_pull":
      await pullFromRemote();
      return;
    default:
      throw new Error(`Unknown job kind: ${kind}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
