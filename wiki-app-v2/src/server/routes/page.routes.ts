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
import { getBranchChain, resolveSpaceRole, canViewPage } from "../services/branch.service.js";
import { diffRevisions } from "../services/diff.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { UserContext } from "../../shared/types.js";
import { dispatchHook } from "../hooks.js";
import { getPageBacklinks } from "../services/backlink.service.js";
import { resolveInheritedAttributes } from "../services/template.service.js";
import { processMentions } from "../services/mention.service.js";
import { getPageHistory, getFileContentAtCommit } from "../services/git.service.js";
import { enqueueJob } from "../services/queue.service.js";
import { markdownToTiptap, stripFrontmatter } from "../services/markdown.service.js";
import { ensureBlockIds } from "../../shared/blockIds.js";

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
      const backlinks = await getPageBacklinks(row.page.id, (request as any).userContext as UserContext | null);
      // Only list placements the caller can actually open — a page cloned into
      // a restricted space must not leak that placement's slug via the readable
      // one (§13.1). Anonymous (share-token) callers see only the placement
      // they're viewing.
      const user = (request as any).userContext as UserContext | null;
      const allPlacements = await db
        .select({ id: branches.id, slug: pages.slug })
        .from(branches)
        .innerJoin(pages, eq(branches.pageId, pages.id))
        .where(eq(branches.pageId, row.page.id));
      const placements: { id: string; slug: string }[] = [];
      for (const p of allPlacements) {
        if (!user) {
          if (p.id === branchId) placements.push(p);
          continue;
        }
        const chain = await getBranchChain(p.id).catch(() => null);
        if (!chain) continue;
        const spaceRole = user.isAdmin
          ? "admin" as const
          : await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
        if (resolveAccess(user, chain, spaceRole) !== "none") placements.push(p);
      }

      const access = (request as any).resolvedAccess as string | undefined;
      // §13.3: resolve template chain → direct templates + inherited
      // attributes (page's own attrs win, first template wins among
      // multiple templates, cycle-safe, depth-limited, permission-filtered).
      const { directTemplates, inheritedAttributes } = await resolveInheritedAttributes(
        row.page.id,
        user,
      );
      // Brief §13.5: dispatch the pageLoad hook AFTER reply.send so
      // the user-facing response is never gated on a slow plugin
      // handler. We capture the reply promise but intentionally do
      // not await it — the request handler returns first and the
      // event fires asynchronously. Errors in handlers are caught
      // inside dispatchHook and never bubble up here.
      const viewerUserId = user?.id ?? "anonymous";
      void dispatchHook({
        event: "pageLoad",
        at: new Date().toISOString(),
        actorUserId: viewerUserId,
        pageId: row.page.id,
        branchId,
      });
      return reply.send({
        id: row.page.id,
        slug: row.page.slug,
        title: row.page.title,
        content: row.page.content,
        updatedAt: row.page.updatedAt,
        branchId: row.branch.id,
        access,
        // §13.6: pageType/language tell the client whether to mount the rich-text
        // editor or the code editor. `language` is null for wiki pages.
        pageType: row.page.pageType,
        language: row.page.language ?? null,
        // §13.7: when true, `content` is a CryptoEnvelope; the client must prompt
        // for a passphrase and decrypt before rendering.
        isEncrypted: row.page.isEncrypted,
        attributes: attrs,
        placements,
        backlinks,
        templates: directTemplates,
        inheritedAttributes,
      });
    }
  );

  // §7.12 block-refs + backlinks: every page that links into this page. The
  // page's own GET already embeds backlinks for the editor panel; this route is
  // the API-parity endpoint the regression suite targets. Callers must be able
  // to read the target page (else the endpoint would leak its existence) and
  // source pages they can't access are filtered out of the result (§13.1).
  app.get(
    "/api/pages/:pageId/backlinks",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const { pageId } = request.params as { pageId: string };
      const user = (request as any).userContext as UserContext;
      if (!(await canViewPage(user, pageId))) {
        return reply.code(404).send({ error: "Page not found" });
      }
      try {
        const backlinks = await getPageBacklinks(pageId, user);
        return reply.send({ backlinks });
      } catch {
        return reply.send({ backlinks: [] });
      }
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
    // §13.7: true means `content` is a CryptoEnvelope to persist verbatim.
    encrypted: z.boolean().optional(),
  }).strict();

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
        branchId,
        title: body.title,
        titleProvided: body.titleProvided,
        content: body.content,
        expectedUpdatedAt: body.expectedUpdatedAt,
        encrypted: body.encrypted,
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
      // Mention notifications are derived data — fire-and-forget so a slow
      // notification fan-out never delays the save response. Skipped for
      // encrypted saves: the body is ciphertext, so there are no mentions to
      // extract (and we never have the plaintext server-side).
      if (!body.encrypted) {
        processMentions(row.page.id, branchId, row.page.slug, (request as any).userContext?.id ?? "", body.content).catch(() => {});
      }
      const saveResponse = { ok: true, updatedAt: fresh?.updatedAt, title: fresh?.title };

      // Brief §13.5: dispatch pageSave hook AFTER the reply is sent
      // so plugin latency never affects the user. Same pattern as
      // pageLoad above.
      void dispatchHook({
        event: "pageSave",
        at: new Date().toISOString(),
        actorUserId: (request as any).userContext?.id ?? "anonymous",
        pageId: row.page.id,
        branchId,
      });

      return reply.send(saveResponse);
    }
  );

  // -------------------------------------------------------------------------
  // Page creation — the editor's "new page" action. Space-scoped (editor on
  // the space), created under a parent branch if one is given.
  // -------------------------------------------------------------------------

  // The slug becomes the git file name (<space>/<slug>.md) — it must never
  // contain a path separator (path traversal out of the repo) or start with
  // a separator/`.`/`-` (hidden files, git option injection via a leading
  // dash when the space slug is empty). No current page uses anything beyond
  // letters, digits, `-`, `_`, `.` — and the leading/trailing char must be
  // alphanumeric.
  const PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

  const createPageBody = z.object({
    slug: z.string().min(1).max(120).regex(PAGE_SLUG_RE),
    title: z.string().optional(),
    parentBranchId: z.string().nullable().optional(),
    // §13.6: code pages are whole-file source/config notes. `language` drives
    // highlighting + the git file extension; absent → wiki page.
    pageType: z.enum(["wiki", "code"]).optional(),
    language: z.string().max(40).nullable().optional(),
    templateId: z.string().uuid().optional(),
  }).strict();

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
        pageType: body.pageType ?? "wiki",
        language: body.language ?? null,
        templateId: body.templateId,
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

  const trashBody = z.object({ pageId: z.string().min(1) }).strict();

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

  const renameBody = z.object({ slug: z.string().min(1).max(120).regex(PAGE_SLUG_RE) }).strict();

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

      const oldSlug = row.page.slug;
      await renamePage(pageId, body.slug);
      // The slug is part of the git file path and frontmatter — a rename with
      // no subsequent edit must still be reflected in the repo, or the git
      // tree keeps the old <slug>.md and drifts from the DB until the next
      // content save. Re-commit under the new slug through the same queue, and
      // carry the previous slug so the commit can drop the old file too.
      await enqueueJob("git_commit", { pageId, branchId, kind: "autosave", oldSlug });
      return reply.send({ ok: true, slug: body.slug });
    }
  );

  // -------------------------------------------------------------------------
  // Git history (§8 step 10 — git flush pipeline). History is read-only and
  // gated on the requesting placement (viewer); restore writes content through
  // the same OCC save as a live edit (editor), and is a NEW forward-moving
  // version, not a git-history rewrite. Snapshots are manual checkpoints with
  // a user-provided message, queued like autosave commits.
  // -------------------------------------------------------------------------

  app.get(
    "/api/pages/:pageId/branches/:branchId/history",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const row = await getPageByBranchId(branchId);
      if (!row || row.page.id !== pageId || row.page.deletedAt) {
        return reply.code(404).send({ error: "Page not found" });
      }
      try {
        return reply.send(await getPageHistory(pageId));
      } catch (err) {
        request.log.warn({ err, pageId }, "Git history unavailable (repo not initialized?)");
        return reply.send([]);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Revision diff (brief §12.3). Given two commits, returns a line-level
  // unified diff of the page body, plus a title-diff signal derived from
  // the YAML frontmatter. Read-only, viewer-gated (same gate as history).
  // -------------------------------------------------------------------------
  app.get(
    "/api/pages/:pageId/branches/:branchId/diff",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const q = z.object({ from: z.string().min(7), to: z.string().min(7) }).parse(request.query);
      const row = await getPageByBranchId(branchId);
      if (!row || row.page.id !== pageId || row.page.deletedAt) {
        return reply.code(404).send({ error: "Page not found" });
      }
      try {
        return reply.send(await diffRevisions(pageId, q.from, q.to));
      } catch (err) {
        request.log.warn({ err, pageId, from: q.from, to: q.to }, "Revision diff failed");
        return reply.code(404).send({ error: "Revision not found" });
      }
    }
  );

  const snapshotBody = z.object({ message: z.string().min(1).max(200) }).strict();

  app.post(
    "/api/pages/:pageId/branches/:branchId/snapshot",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const body = snapshotBody.parse(request.body);
      const row = await getPageByBranchId(branchId);
      if (!row || row.page.id !== pageId || row.page.deletedAt) {
        return reply.code(404).send({ error: "Page not found" });
      }
      if (row.page.isEncrypted) {
        return reply.code(400).send({ error: "Encrypted pages have no git history and cannot be snapshotted" });
      }
      const user = (request as any).userContext as UserContext;
      await enqueueJob("git_commit", {
        pageId,
        branchId,
        kind: "manual_snapshot",
        message: body.message,
        userId: user.id,
      });
      return reply.code(202).send({ queued: true });
    }
  );

  // commitHash is passed into git commands (diff-tree/show). Validate it as
  // hex so a value like "--output=/tmp/x" can never be parsed as a git option.
  const restoreBody = z.object({ commitHash: z.string().regex(/^[0-9a-f]{7,64}$/i) }).strict();

  app.post(
    "/api/pages/:pageId/branches/:branchId/restore",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { pageId, branchId } = request.params as { pageId: string; branchId: string };
      const { commitHash } = restoreBody.parse(request.body);

      const row = await getPageByBranchId(branchId);
      if (!row || row.page.id !== pageId || row.page.deletedAt) {
        return reply.code(404).send({ error: "Page not found" });
      }

      // §13.7: encrypted pages have no git history (the plaintext never reaches
      // the server), so there is no committed version to restore.
      if (row.page.isEncrypted) {
        return reply.code(400).send({ error: "Encrypted pages have no git history and cannot be restored" });
      }

      let fileContent: string | null;
      try {
        fileContent = await getFileContentAtCommit(pageId, commitHash);
      } catch (err) {
        request.log.warn({ err, pageId, commitHash }, "Failed to retrieve content at commit");
        fileContent = null;
      }
      if (fileContent === null) {
        return reply.code(404).send({ error: "Content not found at that commit" });
      }

      // §13.6: a code page's git file is already its raw source, so restore it
      // verbatim. A wiki page's file is markdown (+frontmatter), so round-trip
      // it back through the markdown importer into a Tiptap doc. Both then save
      // as a NEW forward-moving version through the normal OCC path so a
      // concurrent edit still conflicts correctly.
      const content =
        row.page.pageType === "code"
          ? fileContent
          : ensureBlockIds(markdownToTiptap(stripFrontmatter(fileContent)) as never);

      const { db } = getDb();
      const [currentPage] = await db.select({ updatedAt: pages.updatedAt }).from(pages).where(eq(pages.id, pageId));
      if (!currentPage) return reply.code(404).send({ error: "Page not found" });

      const result = await savePageOCC({
        pageId,
        branchId,
        content,
        expectedUpdatedAt: currentPage.updatedAt,
      });
      if (!result.ok) {
        // Same conflict contract as the live save route: someone else saved
        // between the read above and this write, so the client must reload.
        return reply.code(409).send({ error: "Conflict", message: "This page was updated elsewhere. Reload to see the latest version before saving again." });
      }
      return reply.send({ ok: true });
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
