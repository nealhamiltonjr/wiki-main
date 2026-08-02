import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { branches, pages, commentThreads, comments } from "../db/schema.js";
import { getBranchChain, resolveSpaceRole } from "../services/branch.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { UserContext } from "../../shared/types.js";

const createThreadBody = z.object({
  rangeFrom: z.number().int().min(0),
  rangeTo: z.number().int().min(0),
  // Phase 1 (§7.12): the id of the containing block, captured at creation time
  // so the highlight can be re-anchored to the block when earlier edits shift
  // the character range.
  blockId: z.string().max(64).optional(),
  body: z.string().min(1),
  selection: z.string().max(2000).optional(),
});

const addReplyBody = z.object({
  body: z.string().min(1),
});

const updateBody = z.object({
  body: z.string().min(1),
});

// ---- helpers ----

/** Look up the pageId for a branch. Returns null if not found. */
async function getPageId(branchId: string): Promise<string | null> {
  const [branch] = await db.select({ pageId: branches.pageId }).from(branches).where(eq(branches.id, branchId));
  return branch?.pageId ?? null;
}

/**
 * Check that the user has at least `minRole` on the branch that owns a thread.
 * Used for routes that don't carry a branchParam (edit/delete comment, resolve).
 * Returns the thread row if access is granted, null otherwise.
 */
async function checkThreadAccess(
  threadId: string,
  user: UserContext,
  minRole: "viewer" | "editor",
): Promise<{ id: string; pageId: string } | null> {
  const [thread] = await db.select().from(commentThreads).where(eq(commentThreads.id, threadId));
  if (!thread) return null;

  // Find any branch that points to this page (the first one suffices for access check)
  const [branch] = await db.select().from(branches).where(eq(branches.pageId, thread.pageId)).limit(1);
  if (!branch) return null;

  const chain = await getBranchChain(branch.id).catch(() => null);
  if (!chain) return null;

  if (user.isAdmin) return thread;

  const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
  const result = resolveAccess(user, chain, spaceRole);
  const rank = { none: 0, viewer: 1, editor: 2, admin: 3 } as const;
  if (rank[result] < rank[minRole]) return null;

  return thread;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function commentRoutes(app: FastifyInstance) {
  // List all threads for a page (via its branch), with their comments.
  app.get(
    "/api/branches/:branchId/comments",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const pageId = await getPageId(branchId);
      if (!pageId) return reply.code(404).send({ error: "Branch not found" });

      const threads = await db
        .select()
        .from(commentThreads)
        .where(eq(commentThreads.pageId, pageId))
        .orderBy(desc(commentThreads.createdAt));

      const result = await Promise.all(
        threads.map(async (t) => {
          const cs = await db
            .select()
            .from(comments)
            .where(eq(comments.threadId, t.id))
            .orderBy(comments.createdAt);
          return { ...t, comments: cs };
        })
      );

      return reply.send(result);
    }
  );

  // Create a new comment thread with its first comment.
  app.post(
    "/api/branches/:branchId/comments",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const body = createThreadBody.parse(request.body);
      const user = (request as any).userContext as UserContext;
      const pageId = await getPageId(branchId);
      if (!pageId) return reply.code(404).send({ error: "Branch not found" });

      const threadId = crypto.randomUUID();
      db.insert(commentThreads).values({
        id: threadId,
        pageId,
        blockId: body.blockId ?? null,
        rangeFrom: body.rangeFrom,
        rangeTo: body.rangeTo,
        selection: body.selection ?? null,
        createdBy: user.id,
      }).run();

      db.insert(comments).values({
        id: crypto.randomUUID(),
        threadId,
        body: body.body,
        userId: user.id,
      }).run();

      return reply.code(201).send({ threadId });
    }
  );

  // Add a reply to an existing thread.
  app.post(
    "/api/branches/:branchId/comments/:threadId",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId, threadId } = request.params as { branchId: string; threadId: string };
      const body = addReplyBody.parse(request.body);
      const user = (request as any).userContext as UserContext;
      const pageId = await getPageId(branchId);
      if (!pageId) return reply.code(404).send({ error: "Branch not found" });

      // Verify the thread belongs to this page
      const [thread] = await db
        .select()
        .from(commentThreads)
        .where(and(eq(commentThreads.id, threadId), eq(commentThreads.pageId, pageId)));
      if (!thread) return reply.code(404).send({ error: "Thread not found" });

      const commentId = crypto.randomUUID();
      const now = new Date();
      db.insert(comments).values({
        id: commentId,
        threadId,
        body: body.body,
        userId: user.id,
        createdAt: now,
        updatedAt: now,
      }).run();

      return reply.code(201).send({
        id: commentId,
        threadId,
        body: body.body,
        userId: user.id,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    }
  );

  // Edit own comment body.
  app.put(
    "/api/comments/:commentId",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const { commentId } = request.params as { commentId: string };
      const body = updateBody.parse(request.body);
      const user = (request as any).userContext as UserContext;

      const [comment] = await db.select().from(comments).where(eq(comments.id, commentId));
      if (!comment) return reply.code(404).send({ error: "Comment not found" });
      if (comment.userId !== user.id && !user.isAdmin) {
        return reply.code(403).send({ error: "Can only edit your own comments" });
      }

      const thread = await checkThreadAccess(comment.threadId, user, "editor");
      if (!thread) return reply.code(403).send({ error: "Insufficient permissions" });

      await db
        .update(comments)
        .set({ body: body.body, updatedAt: new Date() })
        .where(eq(comments.id, commentId));

      return reply.send({ ok: true });
    }
  );

  // Delete own comment.
  app.delete(
    "/api/comments/:commentId",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const { commentId } = request.params as { commentId: string };
      const user = (request as any).userContext as UserContext;

      const [comment] = await db.select().from(comments).where(eq(comments.id, commentId));
      if (!comment) return reply.code(404).send({ error: "Comment not found" });
      if (comment.userId !== user.id && !user.isAdmin) {
        return reply.code(403).send({ error: "Can only delete your own comments" });
      }

      const thread = await checkThreadAccess(comment.threadId, user, "editor");
      if (!thread) return reply.code(403).send({ error: "Insufficient permissions" });

      await db.delete(comments).where(eq(comments.id, commentId));

      // If this was the last comment, delete the thread too
      const remaining = await db
        .select()
        .from(comments)
        .where(eq(comments.threadId, comment.threadId));
      if (remaining.length === 0) {
        await db.delete(commentThreads).where(eq(commentThreads.id, comment.threadId));
      }

      return reply.send({ ok: true });
    }
  );

  // Toggle thread resolved state.
  app.put(
    "/api/comment-threads/:threadId/resolve",
    { config: { access: "authenticated" } },
    async (request, reply) => {
      const { threadId } = request.params as { threadId: string };
      const user = (request as any).userContext as UserContext;

      const thread = await checkThreadAccess(threadId, user, "editor");
      if (!thread) return reply.code(403).send({ error: "Insufficient permissions" });

      const [t] = await db.select({ resolvedAt: commentThreads.resolvedAt }).from(commentThreads).where(eq(commentThreads.id, threadId));
      const resolved = t?.resolvedAt ? null : new Date();

      await db
        .update(commentThreads)
        .set({ resolvedAt: resolved, resolvedBy: resolved ? user.id : null })
        .where(eq(commentThreads.id, threadId));

      return reply.send({ resolved: !!resolved });
    }
  );
}
