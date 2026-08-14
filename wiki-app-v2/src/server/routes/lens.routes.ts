/**
 * Lens routes — brief §12.4.
 *
 *   GET    /api/lenses              List the caller's own lenses plus public ones.
 *   POST   /api/lenses              Create a new lens.
 *   GET    /api/lenses/:id          Read a lens (owner / public / admin).
 *   PATCH  /api/lenses/:id          Update a lens (owner only).
 *   DELETE /api/lenses/:id          Delete a lens (owner only).
 *   GET    /api/lenses/:id/results  Run the lens and return matching pages.
 *   GET    /api/lenses/by-token/:token  Fetch an unlisted lens by share token.
 *   GET    /api/lenses/by-token/:token/results  Run that lens.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createLens,
  deleteLens,
  getLens,
  getLensByToken,
  listLensesForUser,
  runLens,
  runLensWithAttributes,
  updateLens,
  type LensCriteria,
} from "../services/lens.service.js";
import type { UserContext } from "../../shared/types.js";

const ownerScopeSchema = z.union([
  z.literal("self"),
  z.literal("anyone"),
  z.object({ kind: z.literal("group"), groupId: z.string().min(1) }),
]);

const criteriaSchema = z.object({
  tags: z.array(z.string().min(1)).max(50).optional(),
  properties: z
    .array(z.object({ name: z.string().min(1).max(64), value: z.string().max(256) }))
    .max(20)
    .optional(),
  titleRegex: z.string().min(1).max(256).optional(),
  ownerScope: ownerScopeSchema.optional(),
  spaceIds: z.array(z.string().min(1)).max(100).optional(),
  includeTrash: z.boolean().optional(),
});

const visibilitySchema = z.enum(["private", "unlisted", "public"]);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(280).nullish(),
  criteria: criteriaSchema,
  visibility: visibilitySchema.optional(),
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(280).nullable().optional(),
    criteria: criteriaSchema.optional(),
    visibility: visibilitySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

function caller(request: unknown): UserContext | null {
  return ((request as { userContext?: UserContext | null }).userContext ?? null);
}

/** Visibility gate: only the owner can fetch a private lens. Public lenses
 * are open to anyone; unlisted lenses surface only via their share token. */
function canReadLens(
  lens: { ownerId: string; visibility: "private" | "unlisted" | "public" },
  user: UserContext | null,
): boolean {
  if (user?.isAdmin) return true;
  if (lens.visibility === "public") return true;
  if (user && lens.ownerId === user.id) return true;
  return false;
}

export async function lensRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------
  app.get(
    "/api/lenses",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      const rows = await listLensesForUser(u.id);
      return rows;
    },
  );

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------
  app.post(
    "/api/lenses",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const lens = await createLens({
        ownerId: u.id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        criteria: parsed.data.criteria as LensCriteria,
        visibility: parsed.data.visibility,
      });
      return reply.code(201).send(lens);
    },
  );

  // -------------------------------------------------------------------------
  // Read by id (private lens → owner only; public lens → anyone authenticated)
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/api/lenses/:id",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      const lens = await getLens(request.params.id);
      if (!lens) return reply.code(404).send({ error: "lens not found" });
      if (!canReadLens(lens, u)) return reply.code(403).send({ error: "forbidden" });
      return lens;
    },
  );

  // -------------------------------------------------------------------------
  // Patch (owner only)
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    "/api/lenses/:id",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      const lens = await getLens(request.params.id);
      if (!lens) return reply.code(404).send({ error: "lens not found" });
      if (!u.isAdmin && lens.ownerId !== u.id) return reply.code(403).send({ error: "forbidden" });

      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const updated = await updateLens(request.params.id, {
        name: parsed.data.name,
        description: parsed.data.description,
        criteria: parsed.data.criteria as LensCriteria | undefined,
        visibility: parsed.data.visibility,
      });
      return updated;
    },
  );

  // -------------------------------------------------------------------------
  // Delete (owner only)
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/api/lenses/:id",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      const lens = await getLens(request.params.id);
      if (!lens) return reply.code(404).send({ error: "lens not found" });
      if (!u.isAdmin && lens.ownerId !== u.id) return reply.code(403).send({ error: "forbidden" });
      await deleteLens(request.params.id);
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Run lens by id
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { include?: string } }>(
    "/api/lenses/:id/results",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      const lens = await getLens(request.params.id);
      if (!lens) return reply.code(404).send({ error: "lens not found" });
      if (!canReadLens(lens, u)) return reply.code(403).send({ error: "forbidden" });
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      // §13.4 — when the caller asks for `?include=attributes`, return
      // each hit's promoted attributes (own + inherited via §13.3). The
      // list-only path stays light; the enriched path is opt-in.
      const wantAttributes = request.query.include === "attributes";
      const hits = wantAttributes
        ? await runLensWithAttributes(lens, u)
        : await runLens(lens, u);
      return { lens, hits };
    },
  );

  // -------------------------------------------------------------------------
  // Share-token routes (for unlisted lenses). Token lookup itself is public
  // (no auth required) — the token is the capability. Results still require
  // authentication because we need a UserContext for space access.
  // -------------------------------------------------------------------------
  app.get<{ Params: { token: string } }>(
    "/api/lenses/by-token/:token",
    { config: { access: "public" } },
    async (request, reply) => {
      const lens = await getLensByToken(request.params.token);
      if (!lens) return reply.code(404).send({ error: "lens not found" });
      return lens;
    },
  );

  app.get<{ Params: { token: string }; Querystring: { include?: string } }>(
    "/api/lenses/by-token/:token/results",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const u = caller(request);
      const lens = await getLensByToken(request.params.token);
      if (!lens) return reply.code(404).send({ error: "lens not found" });
      if (!u) return reply.code(401).send({ error: "unauthenticated" });
      const wantAttributes = request.query.include === "attributes";
      const hits = wantAttributes
        ? await runLensWithAttributes(lens, u)
        : await runLens(lens, u);
      return { lens, hits };
    },
  );

  // Reference to silence unused-import warnings on zod when the routes
  // above are the only consumers — kept here for clarity that `z` is the
  // canonical schema source for this module.
  void z;
}
