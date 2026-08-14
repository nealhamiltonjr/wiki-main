import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";

import { authRoutes } from "./auth/routes.js";
import { registerSecurityHeaders } from "./security.js";
import { registerPermissionMiddleware } from "./middleware/access.js";
import { spaceRoutes } from "./routes/space.routes.js";
import { treeRoutes } from "./routes/tree.routes.js";
import { pageRoutes } from "./routes/page.routes.js";
import { branchRoutes } from "./routes/branch.routes.js";
import { fileRoutes } from "./routes/file.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { commentRoutes } from "./routes/comment.routes.js";
import { favoriteRoutes } from "./routes/favorite.routes.js";
import { notificationRoutes } from "./routes/notification.routes.js";
import { gitRoutes } from "./routes/git.routes.js";
import { pluginRoutes } from "./routes/plugin.routes.js";
import { settingsRoutes } from "./routes/settings.routes.js";
import { groupRoutes } from "./routes/group.routes.js";
import { userRoutes } from "./routes/user.routes.js";
import { tokenRoutes } from "./routes/token.routes.js";
import { lensRoutes } from "./routes/lens.routes.js";
import { relationRoutes } from "./routes/relation.routes.js";
import { graphRoutes } from "./routes/graph.routes.js";
import { registerPluginServerRoutes, registerPluginHookHandlers, installPluginFailureHook } from "./services/plugin.service.js";
import { recordSystemLog } from "./services/system-logger.service.js";
import multipart from "@fastify/multipart";

/**
 * Builds a fully-configured Fastify instance WITHOUT calling .listen() — split
 * out from index.ts so tests use Fastify's own `.inject()` to exercise real
 * routes in-process (no network port, no boot races). index.ts is just this
 * function plus .listen() and the startup side-effects.
 */
export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  // Day-one security headers (§3.2): CSP, nosniff, frame-options, referrer.
  registerSecurityHeaders(app);

  // Full permission middleware (§3.8): the declaration invariant (every /api/
  // route except /api/auth/* must declare config.access or the server refuses
  // to boot) PLUS the preHandler enforcement — resolveAccess against branch
  // chains / space roles, bearer-token principals, suspended-user guard,
  // share-link tokens. Registered before any routes so every one after this
  // point is subject to it.
  await registerPermissionMiddleware(app);

  // Found as a real bug in the old app: an unhandled ZodError fell through to
  // Fastify's default handler, returning a bare 500 with the validation error
  // and stack trace exposed to the client. Global handler below. 4xx errors
  // (e.g. Fastify's own FST_REQ_FILE_TOO_LARGE) keep their real status; true
  // surprises stay logged 500s with no internals leaked.
  app.setErrorHandler((error: FastifyError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Validation failed",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }

    request.log.error(error);
    // §11.4 observability: persist a compact summary row so the admin
    // System Health page has something to render. Best-effort — if the
    // system_logs write itself fails, the request still gets a 500
    // response (the in-memory logger line above is the source of truth).
    void recordSystemLog({
      level: "error",
      source: `http:${request.method}`,
      message: error.message || "Internal server error",
      meta: {
        url: request.url,
        method: request.method,
        statusCode: error.statusCode ?? 500,
      },
    });
    return reply.code(500).send({ error: "Internal server error" });
  });

  await app.register(cookie);
  // Multipart for file uploads — 25MB cap (brief §3.2: too-large files must
  // fail cleanly with 413, never a bare 500).
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  await app.register(authRoutes);
  await app.register(spaceRoutes);
  await app.register(treeRoutes);
  await app.register(pageRoutes);
  await app.register(branchRoutes);
  await app.register(fileRoutes);
  await app.register(searchRoutes);
  await app.register(commentRoutes);
  await app.register(favoriteRoutes);
  await app.register(notificationRoutes);
  await app.register(gitRoutes);
  await app.register(pluginRoutes);
  await app.register(settingsRoutes);
  await app.register(groupRoutes);
  await app.register(userRoutes);
  await app.register(tokenRoutes);
  await app.register(lensRoutes);
  await app.register(relationRoutes);
  await app.register(graphRoutes);

  // Register server routes for every enabled plugin that declares the
  // serverRoutes capability. A failing plugin is logged and skipped; it never
  // takes down the whole instance.
  // §11.3: install the failure handler BEFORE any plugin module is loaded so
  // even the boot-time load errors feed the counter.
  installPluginFailureHook();
  await registerPluginServerRoutes(app);

  // Brief §13.5: load hook handlers for every enabled plugin that
  // declares the `hooks` capability. Hooks are NOT subject to the
  // boot-only constraint (Fastify's route table is sealed after
  // ready(); the hook registry is plain memory).
  await registerPluginHookHandlers();

  app.get("/api/health", { config: { access: "public" } }, async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  return app;
}
