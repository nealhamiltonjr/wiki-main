import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { pages, branches, attributes } from "../db/schema.js";
import {
  createPage,
  getPageByBranchId,
  savePageOCC,
  softDeleteBranch,
  restorePage,
  purgePage,
  listTrash,
  deletePageEverywhere,
  renamePage,
} from "../services/page.service.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { UserContext } from "../../shared/types.js";
import { getPageBacklinks } from "../services/backlink.service.js";

export async function pageRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Read + edit a page through one of its branch placements. The branch id is
  // the security key (chain walk), so both routes are branch-scoped.
  // -------------------------------------------------------------------------

  // Returns the page, the requesting placement, its attributes (icon/template
  // etc.), and the incoming backlinks for the backlinks panel. Content is the
  // authoritative Tiptap JSON — the editor renders it directly.
  app.get(
    "/api/branches/:branchId/page",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const row = await getPageByBranchId(branchId);
      if (!row) return reply.code(404).send({ error: "Page not found" });
      if (row.page.deletedAt) return reply.code(404).send({ error: "Page is in trash" });

      const { db } = getDb();
      const attrs = await db.select().from(attributes).where(eq(attributes.pageId, row.page.id));
      const backlinks = await getPageBacklinks(row.page.id);
      const placements = await db
        .select({ id: branches.id, slug: pages.slug })
        .from(branches)
        .innerJoin(pages, eq(branches.pageId, pages.id))
        .where(eq(branches.pageId, row.page.id));

      const access = (request as any).resolvedAccess as string | undefined;
      return reply.send({
        id: row.page.id,
        slug: row.page.slug,
        title: row.page.title,
        content: row.page.content,
        updatedAt: row.page.updatedAt,
        branchId: row.branch.id,
        access,
        attributes: attrs,
        placements,
        backlinks,
      });
    }
  );

  // OCC save (§3.11): the client sends the content plus the updatedAt it last
  // saw. 409 means someone else saved first — the client must reload rather
  // than retry blindly.
  const saveBody = z.object({
    content: z.unknown(),
    title: z.string().optional(),
    titleProvided: z.boolean().optional(),
    expectedUpdatedAt: z.coerce.date(),
  });

  app.put(
    "/api/branches/:branchId/page/content",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const body = saveBody.parse(request.body);
      const row = await getPageByBranchId(branchId);
      if (!row) return reply.code(404).send({ error: "Page not found" });

      const result = await savePageOCC({
        pageId: row.page.id,
        title: body.title,
        titleProvided: body.titleProvided,
        content: body.content,
        expectedUpdatedAt: body.expectedUpdatedAt,
      });

      if (!result.ok) {
        if ("validationErrors" in result) {
          return reply.code(422).send({
            error: "Invalid content",
            message: "The page content contains unrecognized elements and could not be saved. Try pasting as plain text.",
            details: result.validationErrors,
          });
        }
        return reply.code(409).send({
          error: "Conflict",
          message: "This page was updated elsewhere. Reload to see the latest version before saving again.",
        });
      }

      const [fresh] = await getDb().db
        .select({ updatedAt: pages.updatedAt, title: pages.title })
        .from(pages)
        .where(eq(pages.id, row.page.id));
      return reply.send({ ok: true, updatedAt: fresh?.updatedAt, title: fresh?.title });
    }
  );

  // -------------------------------------------------------------------------
  // Page creation — the editor's "new page" action. Space-scoped (editor on
  // the space), created under a parent branch if one is given.
  // -------------------------------------------------------------------------

  const createPageBody = z.object({
    slug: z.string().min(1).max(120),
    title: z.string().optional(),
    parentBranchId: z.string().nullable().optional(),
  });

  app.post(
    "/api/spaces/:spaceId/pages",
    { config: { access: { spaceParam: "spaceId", minRole: "editor" } } },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };
      const body = createPageBody.parse(request.body);
      const user = (request as any).userContext;

      if (body.parentBranchId) {
        // The parent must live in this space, or the new branch would escape
        // the space boundary (the permission check is keyed on spaceId).
        const { db } = getDb();
        const [parent] = await db
          .select({ spaceId: branches.spaceId })
          .from(branches)
          .where(eq(branches.id, body.parentBranchId));
        if (!parent || parent.spaceId !== spaceId) {
          return reply.code(400).send({ error: "Parent branch not found in this space" });
        }
      }

      const { branchId, pageId } = await createPage({
        slug: body.slug,
        title: body.title,
        ownerId: user.id,
        spaceId,
        parentBranchId: body.parentBranchId ?? null,
      });
      return reply.code(201).send({ branchId, pageId });
    }
  );

  // -------------------------------------------------------------------------
  // Trash (brief §12.1). Per-space; restoring/purging is editor-scoped.
  // -------------------------------------------------------------------------

  app.get(
    "/api/spaces/:spaceId/trash",
    { config: { access: { spaceParam: "spaceId", minRole: "viewer" } } },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };
      return reply.send(await listTrash(spaceId));
    }
  );

  const trashBody = z.object({ pageId: z.string().min(1) });

  /** Loads the page row and verifies it has a placement in THIS space's trash (a
   *  page id from another space must not be restorable/purgeable through this
   *  space's route). */
  async function trashPageInSpace(spaceId: string, pageId: string) {
    const { db } = getDb();
    const [pageRow] = await db.select().from(pages).where(eq(pages.id, pageId));
    if (!pageRow || pageRow.deletedAt === null) return null;
    const placement = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.spaceId, spaceId), eq(branches.pageId, pageId)))
      .limit(1);
    return placement.length > 0 ? pageRow : null;
  }

  // Restore a page from trash (clears deletedAt everywhere it's placed).
  app.post(
    "/api/spaces/:spaceId/trash/restore",
    { config: { access: { spaceParam: "spaceId", minRole: "editor" } } },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };
      const body = trashBody.parse(request.body);

      const pageRow = await trashPageInSpace(spaceId, body.pageId);
      if (!pageRow) return reply.code(404).send({ error: "Page not found in trash" });

      await restorePage(body.pageId);
      return reply.send({ ok: true });
    }
  );

  // Permanently delete a page from trash.
  app.post(
    "/api/spaces/:spaceId/trash/purge",
    { config: { access: { spaceParam: "spaceId", minRole: "editor" } } },
    async (request, reply) => {
      const { spaceId } = request.params as { spaceId: string };
      const body = trashBody.parse(request.body);

      const pageRow = await trashPageInSpace(spaceId, body.pageId);
      if (!pageRow) return reply.code(404).send({ error: "Page not found in trash" });

      await purgePage(body.pageId);
      return reply.send({ ok: true });
    }
  );

  // Soft-delete a page through one of its placements (editor on that branch).
  app.delete(
    "/api/branches/:branchId/page",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const row = await getPageByBranchId(branchId);
      if (!row) return reply.code(404).send({ error: "Page not found" });
      await softDeleteBranch(branchId);
      return reply.send({ ok: true });
    }
  );

  // -------------------------------------------------------------------------
  // Rename. The slug lives on the page (shared by every placement), so this is
  // authorized via a single witness branch the caller has editor access on —
  // exactly like content saves.
  // -------------------------------------------------------------------------

  const renameBody = z.object({ slug: z.string().min(1).max(120) });

  app.put(
    "/api/pages/:pageId/branches/:branchId/slug",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const body = renameBody.parse(request.body);

      const row = await getPageByBranchId(branchId);
      if (!row || row.page.id !== pageId || row.page.deletedAt) {
        return reply.code(404).send({ error: "Page not found" });
      }

      await renamePage(pageId, body.slug);
      return reply.send({ ok: true, slug: body.slug });
    }
  );

  // -------------------------------------------------------------------------
  // Delete a page EVERYWHERE: soft-delete the page row and remove every branch
  // (placement). Authorized via a witness branchId in the query string, then
  // requires editor access on EVERY placement of the page — you can't destroy
  // placements in spaces you only have view access to. Any placement with
  // child pages blocks the delete (children would otherwise dangle).
  // -------------------------------------------------------------------------

  app.delete(
    "/api/pages/:pageId",
    { config: { access: { branchParam: "branchId", minRole: "editor", source: "query" } } },
    async (request, reply) => {
      const { pageId } = request.params as { pageId: string };
      const { branchId } = request.query as { branchId?: unknown };
      if (typeof branchId !== "string" || branchId.length === 0) {
        return reply.code(400).send({ error: "Missing branchId (authorization witness)" });
      }

      const witness = await getPageByBranchId(branchId);
      if (!witness || witness.page.id !== pageId) {
        return reply.code(404).send({ error: "Page not found" });
      }

      const { db } = getDb();
      const allBranches = await db.select().from(branches).where(eq(branches.pageId, pageId));
      if (allBranches.length === 0) return reply.code(404).send({ error: "Page not found" });

      const user = (request as any).userContext as UserContext;
      for (const branch of allBranches) {
        if (branch.isSystem) {
          return reply.code(403).send({ error: "Cannot delete a page that exists in a system branch" });
        }
        const chain = await getBranchChain(branch.id).catch(() => null);
        if (!chain) return reply.code(404).send({ error: "Branch not found" });
        const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
        const result = resolveAccess(user, chain, spaceRole);
        if (result !== "editor" && result !== "admin") {
          return reply.code(403).send({ error: "You need editor access on every placement of this page" });
        }
        const [child] = await db.select({ id: branches.id }).from(branches).where(eq(branches.parentBranchId, branch.id)).limit(1);
        if (child) {
          return reply.code(400).send({ error: "Cannot delete a page whose placements still have child pages" });
        }
      }

      await deletePageEverywhere(pageId);
      return reply.send({ ok: true });
    }
  );
}
