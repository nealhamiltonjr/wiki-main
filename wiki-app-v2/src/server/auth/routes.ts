import type { FastifyInstance } from "fastify";

import { getAuth } from "./config.js";

/**
 * better-auth speaks the Web-standard Request/Response API, not Fastify's
 * req/reply. This single wildcard route bridges the two so /api/auth/*
 * (sign-up, sign-in, sign-out, session checks) all work without hand-rolling
 * that logic. No `config.access` here deliberately — these routes must be
 * reachable without a session. This is the ONE intentional exception to
 * "every route declares access" and is exempted explicitly in the access
 * middleware, not by omission.
 */
export async function authRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
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

      const webResponse = await getAuth().handler(webRequest);

      reply.status(webResponse.status);
      webResponse.headers.forEach((value, key) => reply.header(key, value));
      reply.send(await webResponse.text());
    },
  });
}
