import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { assertEncryptionKeyConfigured } from "./services/crypto.service.js";
import { pageRoutes } from "./routes/page.routes.js";
import { branchRoutes } from "./routes/branch.routes.js";
import { treeRoutes } from "./routes/tree.routes.js";
import { spaceRoutes } from "./routes/space.routes.js";
import { fileRoutes } from "./routes/file.routes.js";
import { tokenRoutes } from "./routes/token.routes.js";
import { templateRoutes } from "./routes/template.routes.js";
import { groupRoutes } from "./routes/group.routes.js";
import { settingsRoutes } from "./routes/settings.routes.js";
import { userSettingsRoutes } from "./routes/user-settings.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { commentRoutes } from "./routes/comment.routes.js";
import { clipRoutes } from "./routes/clip.routes.js";
import { mcpRoutes } from "./routes/mcp.routes.js";
import { syncRoutes } from "./routes/sync.routes.js";
import { gitRoutes } from "./routes/git.routes.js";
import { publicRoutes } from "./routes/public.routes.js";
import { exportRoutes } from "./routes/export.routes.js";
import { backlinkRoutes } from "./routes/backlink.routes.js";
import { attributeRoutes } from "./routes/attribute.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { authRoutes } from "./auth/routes.js";
import { registerPermissionMiddleware } from "./middleware/permissions.js";

/**
 * Builds a fully-configured Fastify instance WITHOUT calling .listen() - split
 * out from index.ts specifically so tests can use Fastify's own `.inject()` to
 * exercise real routes in-process, with no real network port, no background
 * process management, and none of the boot-race/flakiness that plagued manual
 * curl-based testing throughout this project's development. index.ts is now
 * just this function plus the two things that genuinely need a running
 * process: .listen() itself, and the Git/worker startup side effects.
 */
export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  assertEncryptionKeyConfigured();
  const app = Fastify({ logger: opts.logger ?? false });

  // Found as a real bug during testing: an unhandled ZodError (from any route's
  // .parse() call) fell through to Fastify's default handler, which returned a
  // bare 500 with the full validation error - and its stack trace - exposed to
  // the client. Every route that validates input needs this, so it's global.
  app.setErrorHandler((error: FastifyError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Validation failed",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    // Found as a real bug: a genuine client error - like Fastify's own
    // FST_REQ_FILE_TOO_LARGE (413) when a file exceeds the upload size limit -
    // was being collapsed into a generic, unhelpful 500 regardless of the
    // error's own correct status code. Any error in the 4xx range (a real
    // Fastify/plugin-thrown client error) keeps its actual status and a
    // readable message; anything else is treated as truly unexpected and
    // stays a logged 500 with no internals leaked to the client.
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }

    request.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });

  await app.register(cookie);
  // Found as a real bug: Fastify defaults to a 1MB body limit, and nothing
  // here overrode it for file uploads specifically - any real photo (easily
  // 2-10MB) hit FST_REQ_FILE_TOO_LARGE immediately. 25MB is a reasonable
  // ceiling for wiki attachments; revisit if larger files are needed.
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  // Registered before any routes, as a global preHandler hook - every route
  // added after this point is automatically subject to it, and (per
  // middleware/permissions.ts) a route with no declared access config is
  // denied by default rather than silently open.
  await registerPermissionMiddleware(app);

  await app.register(authRoutes);
  await app.register(pageRoutes);
  await app.register(branchRoutes);
  await app.register(treeRoutes);
  await app.register(spaceRoutes);
  await app.register(fileRoutes);
  await app.register(tokenRoutes);
  await app.register(templateRoutes);
  await app.register(groupRoutes);
  await app.register(settingsRoutes);
  await app.register(userSettingsRoutes);
  await app.register(adminRoutes);
  await app.register(commentRoutes);
  await app.register(clipRoutes);
  await app.register(mcpRoutes);
  await app.register(syncRoutes);
  await app.register(gitRoutes);
  await app.register(exportRoutes);
  await app.register(backlinkRoutes);
  await app.register(attributeRoutes);
  await app.register(searchRoutes);
  await app.register(publicRoutes);

  // Production only - in dev, Vite's own server (with its /api proxy) serves the
  // frontend instead, so this doesn't run and doesn't need `npm run build:client`
  // to have been run first. WIKI_DIST_DIR lets tests build into an isolated
  // directory instead of clobbering a live deployment's real dist/.
  if (process.env.NODE_ENV === "production") {
    const distDir =
      process.env.WIKI_DIST_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../dist");

    // Scoped to /assets/ deliberately, NOT the dist root - @fastify/static
    // registers its own internal wildcard GET route to serve arbitrary paths,
    // and registering it unprefixed was found to shadow every unmatched
    // /api/* request too. Vite's build only ever references files under
    // /assets/, so scoping there is both correct and sufficient.
    await app.register(fastifyStatic, { root: path.join(distDir, "assets"), prefix: "/assets/" });

    app.get("/", { config: { access: "public" } }, (_request, reply) => reply.sendFile("index.html", distDir));

    // SPA fallback: any other GET that isn't an API route serves index.html,
    // so client-side routing (React Router) works on a hard refresh at e.g.
    // /pages/some-branch-id. Genuinely unmatched /api/* routes now correctly
    // reach here too and get a clean JSON 404 instead of the SPA shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html", distDir);
      }
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return app;
}
