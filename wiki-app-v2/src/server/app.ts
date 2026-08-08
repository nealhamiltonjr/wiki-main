import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";

import { authRoutes } from "./auth/routes.js";
import { registerSecurityHeaders } from "./security.js";
import { registerAccessDeclarationCheck } from "./middleware/access.js";

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

  // Every /api/ route (except /api/auth/*) must declare config.access or the
  // server refuses to boot (§3.2).
  registerAccessDeclarationCheck(app);

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
    return reply.code(500).send({ error: "Internal server error" });
  });

  await app.register(cookie);
  await app.register(authRoutes);

  app.get("/api/health", { config: { access: "public" } }, async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  return app;
}
