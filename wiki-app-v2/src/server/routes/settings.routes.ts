import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { systemSettings } from "../db/schema.js";

// Slice-14 settings surface (§7.1 System / Integrations). `systemSettings`
// (brief §3.9) is admin-only config; secret values are written through
// setSystemSetting with isSecret=true so the list route masks them. No plaintext
// secret ever leaves the server.
const setSettingBody = z.object({
  value: z.unknown(),
  isSecret: z.boolean().optional(),
});

const gitRemoteBody = z.object({
  url: z.string().max(500),
  branch: z.string().max(200).optional(),
});

export async function setSystemSetting(
  key: string,
  value: unknown,
  isSecret: boolean,
  actorUserId: string
): Promise<void> {
  const { db } = getDb();
  await db
    .insert(systemSettings)
    .values({ key, value, isSecret, updatedBy: actorUserId })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value, isSecret, updatedAt: new Date(), updatedBy: actorUserId },
    });
}

export async function settingsRoutes(app: FastifyInstance) {
  // §7.1 System — read-only diagnostics. Paths are resolved from the same env
  // vars the services use (no secrets, no file contents — just configuration).
  app.get("/api/settings/system-info", { config: { access: "admin" } }, async (_request, reply) => {
    return reply.send({
      storage: {
        dbPath: process.env.DB_PATH ?? "data/wiki.db (default)",
        gitRepoRoot: process.env.GIT_REPO_ROOT ?? "data/repo (default)",
        pluginRoot: process.env.PLUGIN_ROOT ?? "data/plugins (default)",
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
      },
      integrations: {
        googleSso: !!process.env.GOOGLE_CLIENT_ID,
        githubSso: !!process.env.GITHUB_CLIENT_ID,
        authUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
        privateClipHostsAllowed: process.env.ALLOW_PRIVATE_CLIP_HOSTS === "1",
      },
    });
  });

  // All system settings; secret values come back masked (key + isSecret only).
  app.get("/api/settings", { config: { access: "admin" } }, async (_request, reply) => {
    const { db } = getDb();
    const rows = await db.select().from(systemSettings);
    return reply.send(
      rows.map((r) => ({
        key: r.key,
        isSecret: r.isSecret,
        value: r.isSecret ? undefined : r.value,
        updatedAt: r.updatedAt,
        updatedBy: r.updatedBy,
      }))
    );
  });

  app.put("/api/settings/:key", { config: { access: "admin" } }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = setSettingBody.parse(request.body);
    const user = (request as any).userContext;
    await setSystemSetting(key, body.value, body.isSecret ?? false, user.id);
    return reply.send({ key, value: body.isSecret ? undefined : body.value });
  });

  // §7.1 Integrations — Git remote config. Stored in system_settings; push/pull
  // automation consumes it later (git.routes.ts documents this split).
  app.get("/api/git/remote", { config: { access: "admin" } }, async (_request, reply) => {
    const { db } = getDb();
    const rows = await db.select().from(systemSettings);
    const valueOf = (key: string) => rows.find((r) => r.key === key)?.value;
    const url = typeof valueOf("git.remoteUrl") === "string" ? (valueOf("git.remoteUrl") as string) : "";
    const branch = typeof valueOf("git.remoteBranch") === "string" ? (valueOf("git.remoteBranch") as string) : "main";
    return reply.send({ url, branch });
  });

  app.put("/api/git/remote", { config: { access: "admin" } }, async (request, reply) => {
    const body = gitRemoteBody.parse(request.body);
    const user = (request as any).userContext;
    const branch = body.branch?.trim() || "main";
    await setSystemSetting("git.remoteUrl", body.url.trim(), false, user.id);
    await setSystemSetting("git.remoteBranch", branch, false, user.id);
    return reply.send({ url: body.url.trim(), branch });
  });
}
