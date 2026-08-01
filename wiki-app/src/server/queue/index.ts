import { db } from "../db/index.js";
import { jobQueue } from "../db/schema.js";

export async function enqueueJob(kind: string, payload: unknown, runAfter?: Date) {
  await db.insert(jobQueue).values({
    id: crypto.randomUUID(),
    kind,
    payload: payload as any,
    status: "pending",
    runAfter: runAfter ?? new Date(),
  });
}
