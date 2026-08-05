import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pages, branches } from "../db/schema.js";
import { createPage, savePageOCC, createSnapshot } from "../services/page.service.js";
import { getPageHistory, getFileContentAtCommit } from "../services/git.service.js";
import { refreshBacklinks } from "../services/backlink.service.js";
import { indexPage, extractTitle } from "../services/search.service.js";
import { processMentions } from "../services/mention.service.js";
import { markdownToTiptap, stripFrontmatter } from "../services/markdown.service.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { getTemplateContent } from "../services/template.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { UserContext } from "../../shared/types.js";

const createPageBody = z.object({
  slug: z.string().min(1),
  title: z.string().max(500).optional(), // UI overhaul A1: real title column
  spaceId: z.string(),
  parentBranchId: z.string().nullable(),
  templateId: z.string().optional(),
});

const saveBody = z.object({
  title: z.string().max(500).optional(), // UI overhaul A3: title is independent of body OCC
  content: z.unknown(),
  expectedUpdatedAt: z.coerce.date(),
});

const snapshotBody = z.object({ message: z.string().min(1) });

const renameBody = z.object({ slug: z.string().min(1) });

/**
 * The permission middleware authorizes against the URL's branchId alone, but
 * save/snapshot/history also carry a separate pageId in the URL. Those two must
 * be cross-checked: operating on a pageId that doesn't belong to the branch
 * would let anyone with editor access to any branch read/overwrite content they
 * were never granted access to (the same class of bug the file-serving path
 * already defends against in file.service.ts - here the target is content).
 * 404 rather than 403 so we don't leak whether a page exists elsewhere.
 */
async function requireBranchForPage(pageId: string, branchId: string, reply: FastifyReply): Promise<boolean> {
  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!branch || branch.pageId !== pageId) {
    reply.code(404).send({ error: "Page not found for this branch" });
    return false;
  }
  return true;
}

export async function pageRoutes(app: FastifyInstance) {
  // Fetch a page's content via a specific branch (placement) - this is what the
  // editor loads on open. Requires only viewer access; whether the client shows
  // an editable or read-only view is decided client-side from the resolvedAccess
  // the middleware attaches, echoed back here.
  app.get(
    "/api/branches/:branchId/page",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) return reply.code(404).send({ error: "Branch not found" });

      const [page] = await db.select().from(pages).where(eq(pages.id, branch.pageId));
      if (!page || page.deletedAt) return reply.code(404).send({ error: "Page not found" });

      return reply.send({
        pageId: page.id,
        branchId: branch.id,
        slug: page.slug,
        title: page.title, // real title column (UI overhaul A1)
        content: page.content,
        updatedAt: page.updatedAt,
        access: (request as any).resolvedAccess,
      });
    }
  );

  // Creating a page requires editor access on the PARENT branch it's being
  // placed under - OR, for a top-level page (no parent), editor access on the
  // space itself. This is the one route where the check genuinely depends on
  // the request body's shape (branch-scoped vs. space-scoped), which the
  // declarative per-route config can't express - so it calls the same
  // underlying primitives (resolveSpaceRole / getBranchChain + resolveAccess)
  // directly instead. Every other route stays purely declarative.
  app.post("/api/pages", { config: { access: "authenticated" } }, async (request, reply) => {
    const body = createPageBody.parse(request.body);
    const user = (request as any).userContext;

    if (body.parentBranchId === null) {
      const role = await resolveSpaceRole(user.id, body.spaceId, user.groupIds);
      if (!user.isAdmin && (!role || (role !== "editor" && role !== "admin"))) {
        return reply.code(403).send({ error: "Insufficient space permissions" });
      }
    } else {
      const chain = await getBranchChain(body.parentBranchId).catch(() => null);
      if (!chain) return reply.code(404).send({ error: "Parent branch not found" });
      const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
      const result = resolveAccess(user, chain, spaceRole);
      if (result !== "editor" && result !== "admin") {
        return reply.code(403).send({ error: "Insufficient permissions" });
      }
    }

    const initialContent = body.templateId ? await getTemplateContent(body.templateId) : undefined;
    const result = await createPage({
      slug: body.slug,
      title: body.title,
      ownerId: user.id,
      spaceId: body.spaceId,
      parentBranchId: body.parentBranchId,
      initialContent: initialContent ?? undefined,
    });
    const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };
    const doc = (initialContent as unknown) ?? emptyDoc;
    await indexPage(result.pageId, body.title?.trim() || extractTitle(doc), doc, body.slug);
    return reply.code(201).send(result);
  });

  app.put(
    "/api/pages/:pageId/branches/:branchId",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const body = saveBody.parse(request.body);
      if (!(await requireBranchForPage(pageId, branchId, reply))) return;
      // UI overhaul A3: an explicit title wins; otherwise keep today's
      // behavior of deriving it from the first body H1 so nothing regresses
      // until the client ships a real title input (B5).
      const title = body.title?.trim() || extractTitle(body.content) || undefined;
      const result = await savePageOCC({
        pageId,
        branchId,
        title,
        titleProvided: body.title !== undefined,
        content: body.content,
        expectedUpdatedAt: body.expectedUpdatedAt,
      });
      if (!result.ok) return reply.code(409).send({ error: "conflict", message: "Reload the latest version" });
      await refreshBacklinks(pageId, body.content);
      const pageRow = await db.query.pages.findFirst({ where: (t, { eq }) => eq(t.id, pageId) });
      await indexPage(pageId, title ?? "", body.content, pageRow?.slug);
      // Fire-and-forget: mention processing must not block the save response.
      processMentions(pageId, branchId, title ?? pageRow?.slug ?? "", (request as any).userContext?.id, body.content).catch(() => {});
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/api/pages/:pageId/branches/:branchId/snapshot",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const body = snapshotBody.parse(request.body);
      if (!(await requireBranchForPage(pageId, branchId, reply))) return;
      const user = (request as any).userContext;
      await createSnapshot({ pageId, branchId, message: body.message, userId: user.id });
      return reply.code(202).send({ queued: true });
    }
  );

  app.get(
    "/api/pages/:pageId/branches/:branchId/history",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      if (!(await requireBranchForPage(pageId, branchId, reply))) return;
      return reply.send(await getPageHistory(pageId));
    }
  );

  // Restore page content from a historical git commit (brief §7.4).
  // Reads the Markdown file at that commit, converts it back to Tiptap JSON,
  // and saves it as a new forward-moving version (not a git-history rewrite).
  const restoreBody = z.object({ commitHash: z.string().min(1) });

  app.post(
    "/api/pages/:pageId/branches/:branchId/restore",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const { commitHash } = restoreBody.parse(request.body);
      if (!(await requireBranchForPage(pageId, branchId, reply))) return;

      const markdown = await getFileContentAtCommit(pageId, commitHash).catch((err) => {
        request.log.warn({ err, pageId, commitHash }, "Failed to retrieve content at commit");
        return null;
      });
      if (markdown === null) {
        return reply.code(404).send({ error: "Content not found at that commit" });
      }

      const content = markdownToTiptap(stripFrontmatter(markdown));

      // Fetch the current updatedAt for OCC — restore is still an
      // optimistic-locking save, so we need the latest timestamp.
      const [currentPage] = await db.select({ updatedAt: pages.updatedAt }).from(pages).where(eq(pages.id, pageId));
      if (!currentPage) return reply.code(404).send({ error: "Page not found" });

      const result = await savePageOCC({
        pageId,
        branchId,
        content,
        expectedUpdatedAt: currentPage.updatedAt,
      });
      if (!result.ok) {
        return reply.code(500).send({ error: "Failed to save restored content" });
      }
      return reply.send({ ok: true });
    }
  );

  // Rename a page. The slug lives on the page (shared by every placement), so
  // this is authorized via a single witness branch the caller has editor access
  // on - exactly like content saves.
  app.put(
    "/api/pages/:pageId/branches/:branchId/slug",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const body = renameBody.parse(request.body);
      if (!(await requireBranchForPage(pageId, branchId, reply))) return;
      const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
      if (!page || page.deletedAt) return reply.code(404).send({ error: "Page not found" });

      await db.update(pages).set({ slug: body.slug }).where(eq(pages.id, pageId));
      return reply.send({ ok: true, slug: body.slug });
    }
  );

  // Delete a page EVERYWHERE: soft-delete the page row and remove every branch
  // (placement). Authorized via a witness branchId in the query string (the
  // middleware reads config.access.source = "query"), then requires editor
  // access on EVERY placement of the page - you can't destroy placements in
  // spaces you only have view access to.
  app.delete(
    "/api/pages/:pageId",
    { config: { access: { branchParam: "branchId", minRole: "editor", source: "query" } } },
    async (request, reply) => {
      const { pageId } = request.params as { pageId: string };
      const { branchId } = request.query as { branchId?: unknown };
      if (typeof branchId !== "string" || branchId.length === 0) {
        return reply.code(400).send({ error: "Missing branchId (authorization witness)" });
      }
      if (!(await requireBranchForPage(pageId, branchId, reply))) return;
      const user = (request as any).userContext as UserContext;

      const allBranches = await db.select().from(branches).where(eq(branches.pageId, pageId));
      if (allBranches.length === 0) return reply.code(404).send({ error: "Page not found" });

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

      db.transaction((tx) => {
        for (const branch of allBranches) {
          tx.delete(branches).where(eq(branches.id, branch.id)).run();
        }
        tx.update(pages).set({ deletedAt: new Date() }).where(eq(pages.id, pageId)).run();
      });

      return reply.send({ ok: true });
    }
  );
}

