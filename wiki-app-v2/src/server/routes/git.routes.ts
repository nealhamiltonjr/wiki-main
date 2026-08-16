import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getRepoStatus,
  getRepoLog,
  listSnapshots,
  restoreSnapshot,
  pushToRemote,
  pullFromRemote,
  runGitGc,
  getGitRemoteConfig,
  cloneFromRemote,
  restoreDbFromRepo,
} from "../services/git.service.js";
import { enqueueJob } from "../services/queue.service.js";
import { getSystemSetting } from "./settings.routes.js";

const restoreBody = z.object({ commitHash: z.string().min(7).max(64) }).strict();
const snapshotBody = z.object({ message: z.string().max(500).optional() }).strict();
const cloneBody = z.object({ url: z.string().min(1).max(500), branch: z.string().min(1).max(200) }).strict();

/**
 * Admin git section (§8 step 10). Status/log are cheap and read-only. The
 * write path (autosave + manual snapshots) runs through the commit queue.
 * Snapshot/restore/push/pull/gc live here too (Slices B/C/D) — all admin-only.
 */
export async function gitRoutes(app: FastifyInstance) {
  app.get("/api/git/status", { config: { access: "admin" } }, async (_request, reply) => {
    const status = await getRepoStatus();
    const remote = await getGitRemoteConfig().catch(() => ({ url: "", branch: "main" }));
    const lastPushAt = await getSystemSetting<string | null>("git.lastPushAt", null);
    const lastPullAt = await getSystemSetting<string | null>("git.lastPullAt", null);
    const lastError = await getSystemSetting<string | null>("git.lastError", null);
    return reply.send({ ...status, remote, lastPushAt, lastPullAt, lastError });
  });

  app.get("/api/git/log", { config: { access: "admin" } }, async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    const n = Math.min(Math.max(parseInt(limit ?? "25", 10) || 25, 1), 200);
    return reply.send(await getRepoLog(n));
  });

  // -------------------------------------------------------------------------
  // Snapshots (Slice B/C)
  // -------------------------------------------------------------------------
  app.post("/api/git/snapshot", { config: { access: "admin" } }, async (request, reply) => {
    const body = snapshotBody.parse(request.body ?? {});
    const user = (request as any).userContext as { id: string } | undefined;
    const id = await enqueueJob("git_db_snapshot", {
      trigger: "manual",
      message: body.message,
      userId: user?.id,
    });
    return reply.code(202).send({ queued: true, jobId: id });
  });

  app.get("/api/git/snapshots", { config: { access: "admin" } }, async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    const n = Math.min(Math.max(parseInt(limit ?? "20", 10) || 20, 1), 100);
    return reply.send(await listSnapshots(n));
  });

  app.get("/api/git/snapshot-status", { config: { access: "admin" } }, async (_request, reply) => {
    const [last] = await listSnapshots(1);
    const status = await getRepoStatus().catch(() => null);
    const enabled = await getSystemSetting("snapshot.enabled", true);
    const intervalHours = Number(await getSystemSetting("snapshot.intervalHours", 6)) || 6;
    return reply.send({
      lastSnapshotAt: last?.date ?? null,
      lastSnapshotMessage: last?.message ?? null,
      dirtyCount: status?.dirty ?? 0,
      enabled,
      intervalHours,
    });
  });

  app.post("/api/git/restore-snapshot", { config: { access: "admin" } }, async (request, reply) => {
    const body = restoreBody.parse(request.body);
    await restoreSnapshot(body.commitHash);
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Remote + gc (Slice D)
  // -------------------------------------------------------------------------
  app.post("/api/git/push", { config: { access: "admin" } }, async (_request, reply) => {
    try {
      const res = await pushToRemote();
      await import("./settings.routes.js").then(({ setSystemSetting }) =>
        setSystemSetting("git.lastPushAt", new Date().toISOString(), false, "system"),
      );
      return reply.send(res);
    } catch (err) {
      await import("./settings.routes.js").then(({ setSystemSetting }) =>
        setSystemSetting("git.lastError", (err as Error).message, false, "system"),
      );
      reply.log.error(err); return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.post("/api/git/pull", { config: { access: "admin" } }, async (_request, reply) => {
    try {
      const res = await pullFromRemote();
      await import("./settings.routes.js").then(({ setSystemSetting }) =>
        setSystemSetting("git.lastPullAt", new Date().toISOString(), false, "system"),
      );
      return reply.send(res);
    } catch (err) {
      await import("./settings.routes.js").then(({ setSystemSetting }) =>
        setSystemSetting("git.lastError", (err as Error).message, false, "system"),
      );
      reply.log.error(err); return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.post("/api/git/gc", { config: { access: "admin" } }, async (_request, reply) => {
    await runGitGc();
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Fresh install / recover (Slice E)
  // -------------------------------------------------------------------------
  app.post("/api/git/clone", { config: { access: "admin" } }, async (request, reply) => {
    const body = cloneBody.parse(request.body);
    try {
      await cloneFromRemote(body.url, body.branch);
      return reply.send({ ok: true });
    } catch (err) {
      reply.log.error(err); return reply.code(400).send({ error: "Bad request" });
    }
  });

  app.post("/api/git/restore-db", { config: { access: "admin" } }, async (_request, reply) => {
    try {
      await restoreDbFromRepo();
      return reply.send({ ok: true });
    } catch (err) {
      reply.log.error(err); return reply.code(400).send({ error: "Bad request" });
    }
  });
}
