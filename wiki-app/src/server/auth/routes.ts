import type { FastifyInstance } from "fastify";
import { auth } from "./config.js";

/**
 * better-auth ships a single handler that speaks the Web-standard
 * Request/Response API, not Fastify's req/reply. This bridges the two so
 * /api/auth/* (sign-up, sign-in, sign-out, OAuth callbacks, session checks)
 * all work without hand-rolling any of that logic ourselves.
 */
export async function authRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    // No `access` config here deliberately - these routes must be reachable
    // without a session (you can't log in with a session you don't have yet).
    // This is the ONE intentional exception to "every route declares access";
    // it's exempted explicitly in the permission middleware, not by omission.
    handler: async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(", "));
      }

      const webRequest = new Request(url, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : JSON.stringify(request.body),
      });

      const webResponse = await auth.handler(webRequest);

      reply.status(webResponse.status);
      webResponse.headers.forEach((value, key) => reply.header(key, value));
      const text = await webResponse.text();
      reply.send(text);
    },
  });
}
