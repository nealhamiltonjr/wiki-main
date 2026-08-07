import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { branches, pages } from "../db/schema.js";
import {
  getBranchChain, resolveSpaceRole, listBranchPermissions, setBranchPermissions, removeBranchPermission,
} from "../services/branch.service.js";
import { listGroups } from "../services/group.service.js";
import { resolveAccess } from "../../shared/permissions/algorithm.js";
import type { UserContext } from "../../shared/types.js";

const cloneBody = z.object({
  targetSpaceId: z.string().min(1),
  targetParentBranchId: z.string().min(1).nullable(),
});

const moveBody = z.object({
  newParentBranchId: z.string().min(1).nullable(),
});

/**
 * Can this user MANAGE a branch's permission boundary? Stricter than plain
 * content access: requires global admin, space admin, or editor-level access
 * via the algorithm. Space admins always retain management power even after a
 * boundary they set caps their own content role - otherwise granting a
 * viewer-only boundary could permanently lock the space's administrators out
 * of managing it (§7.12g management override).
 */
async function canManagePermissions(user: UserContext, branchId: string): Promise<boolean> {
  if (user.isAdmin) return true;
  const chain = await getBranchChain(branchId).catch(() => null);
  if (!chain) return false;
  const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
  if (spaceRole === "admin") return true;
  return resolveAccess(user, chain, spaceRole) === "editor";
}

/**
 * Is this user allowed to create-or-keep an editor-level placement under the
 * given parent branch (or directly in the space when parent is null)? Mirrors
 * the POST /api/pages permission logic exactly - cloning into a space is the
 * same kind of structural change as creating a new page there.
 */
async function canEditInDestination(
  user: UserContext,
  parentBranchId: string | null,
  spaceId: string
): Promise<boolean> {
  if (user.isAdmin) return true;
  if (parentBranchId === null) {
    const role = await resolveSpaceRole(user.id, spaceId, user.groupIds);
    return role === "editor" || role === "admin";
  }
  const chain = await getBranchChain(parentBranchId).catch(() => null);
  if (!chain) return false;
  const spaceRole = await resolveSpaceRole(user.id, chain[0]!.spaceId, user.groupIds);
  const result = resolveAccess(user, chain, spaceRole);
  return result === "editor" || result === "admin";
}

export async function branchRoutes(app: FastifyInstance) {
  // Clone: create a NEW placement (branches row) for the SAME page - the whole
  // reason the pages/branches split exists (§3.1). Source is checked by the
  // middleware (viewer - you must be able to see what you're cloning); the
  // destination is checked here (editor - you must be able to add a placement
  // to the target space). Visibility starts at "inherit" like a new page.
  app.post(
    "/api/branches/:branchId/clone",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const body = cloneBody.parse(request.body);
      const user = (request as any).userContext as UserContext;

      const [sourceBranch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!sourceBranch) return reply.code(404).send({ error: "Branch not found" });
      if (sourceBranch.isSystem) return reply.code(403).send({ error: "System branches cannot be cloned" });
      const [sourcePage] = await db.select().from(pages).where(eq(pages.id, sourceBranch.pageId));
      if (!sourcePage || sourcePage.deletedAt) return reply.code(404).send({ error: "Page not found" });

      if (!(await canEditInDestination(user, body.targetParentBranchId, body.targetSpaceId))) {
        return reply.code(403).send({ error: "Insufficient destination permissions" });
      }

      if (body.targetParentBranchId !== null) {
        const [parent] = await db.select().from(branches).where(eq(branches.id, body.targetParentBranchId));
        if (!parent) return reply.code(404).send({ error: "Target parent branch not found" });
        if (parent.spaceId !== body.targetSpaceId) {
          return reply.code(400).send({ error: "Target parent is not in the target space" });
        }
        if (parent.isSystem) return reply.code(403).send({ error: "Cannot clone under a system branch" });
      }

      const newBranchId = crypto.randomUUID();
      await db.insert(branches).values({
        id: newBranchId,
        pageId: sourcePage.id,
        parentBranchId: body.targetParentBranchId,
        spaceId: body.targetSpaceId,
        visibility: "inherit",
        isSystem: false,
        createdBy: user.id,
      });

      return reply.code(201).send({ branchId: newBranchId, pageId: sourcePage.id });
    }
  );

  // Move / reparent a placement. The middleware checks editor access on the
  // branch being moved; this handler also checks editor access on the new parent
  // (or on the space itself when moving to the root) and guards against cycles.
  app.put(
    "/api/branches/:branchId/move",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const body = moveBody.parse(request.body);
      const user = (request as any).userContext as UserContext;

      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) return reply.code(404).send({ error: "Branch not found" });
      if (branch.isSystem) return reply.code(403).send({ error: "System branches cannot be moved" });
      const [page] = await db.select().from(pages).where(eq(pages.id, branch.pageId));
      if (!page || page.deletedAt) return reply.code(404).send({ error: "Page not found" });

      if (body.newParentBranchId === null) {
        // Moving to the space root: still needs editor on the space itself.
        const role = await resolveSpaceRole(user.id, branch.spaceId, user.groupIds);
        if (!user.isAdmin && role !== "editor" && role !== "admin") {
          return reply.code(403).send({ error: "Insufficient permissions" });
        }
      } else {
        const [parent] = await db.select().from(branches).where(eq(branches.id, body.newParentBranchId));
        if (!parent) return reply.code(404).send({ error: "Parent branch not found" });
        if (parent.spaceId !== branch.spaceId) {
          return reply.code(400).send({ error: "Cannot move a placement across spaces - use clone instead" });
        }
        if (parent.isSystem) return reply.code(403).send({ error: "Cannot move under a system branch" });

        const parentChain = await getBranchChain(parent.id).catch(() => null);
        if (!parentChain) return reply.code(404).send({ error: "Parent branch not found" });
        // Cycle guard: the new parent must not be the branch itself or a descendant of it.
        if (parentChain.some((n) => n.id === branchId)) {
          return reply.code(400).send({ error: "Cannot move a branch under itself or its own descendant" });
        }
        // Editor access on the new parent (the middleware only checks the branch being moved).
        if (!user.isAdmin) {
          const spaceRole = await resolveSpaceRole(user.id, parentChain[0]!.spaceId, user.groupIds);
          const result = resolveAccess(user, parentChain, spaceRole);
          if (result !== "editor" && result !== "admin") {
            return reply.code(403).send({ error: "Insufficient permissions on the target parent" });
          }
        }
      }

      await db.update(branches).set({ parentBranchId: body.newParentBranchId }).where(eq(branches.id, branch.id));
      return reply.send({ ok: true });
    }
  );

  // Remove a single placement (branches row). The page itself persists if other
  // placements still exist. A placement with child pages cannot be removed -
  // otherwise those children would be silently reparented to the space root.
  app.delete(
    "/api/branches/:branchId",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
      if (!branch) return reply.code(404).send({ error: "Branch not found" });
      if (branch.isSystem) return reply.code(403).send({ error: "System branches cannot be removed" });

      const [child] = await db.select({ id: branches.id }).from(branches).where(eq(branches.parentBranchId, branchId)).limit(1);
      if (child) {
        return reply.code(400).send({ error: "Cannot remove a placement that still has child pages - move or remove them first" });
      }

      await db.delete(branches).where(eq(branches.id, branchId));
      return reply.send({ ok: true });
    }
  );

  // -------------------------------------------------------------------------
  // Per-branch group permissions (§7.12g). The permission ENGINE already
  // existed and is untouched; what was missing was the API surface to write the
  // group_permissions table and the UI to use it. All three routes require
  // editor access on the branch (setting a boundary is itself a privileged
  // action, same floor as link creation). "admin" is deliberately not settable
  // here - managing membership/permissions stays space-scoped (brief §3.8).
  // -------------------------------------------------------------------------
  // The middleware grants a "viewer" floor so the handler can apply the
  // management override (space admin always manages) - a strict editor floor
  // would let a boundary an admin sets cap their own management access.
  const manageGuard = async (request: any, reply: any) => {
    const { branchId } = request.params as { branchId: string };
    const user = request.userContext as UserContext;
    if (!(await canManagePermissions(user, branchId))) {
      return reply.code(403).send({ error: "Insufficient permissions to manage page permissions" });
    }
    return null;
  };

  app.get(
    "/api/branches/:branchId/permissions",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await manageGuard(request, reply);
      if (blocked) return blocked;
      const { branchId } = request.params as { branchId: string };
      const grants = await listBranchPermissions(branchId);
      // Available groups, so editors can grant without needing global admin
      // (the /api/groups CRUD stays admin-only; the name list is not sensitive).
      const groups = await listGroups();
      // The branch's space, so the dialog can also surface space-level
      // permissions (default role, members, group grants) alongside the
      // per-branch boundary.
      const [branch] = await db.select({ spaceId: branches.spaceId }).from(branches).where(eq(branches.id, branchId));
      return reply.send({ grants, groups, spaceId: branch?.spaceId ?? null });
    }
  );

  // Replace the branch's explicit grants wholesale. An empty array clears the
  // boundary entirely (falls back to space role / visibility).
  app.put(
    "/api/branches/:branchId/permissions",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await manageGuard(request, reply);
      if (blocked) return blocked;
      const { branchId } = request.params as { branchId: string };
      const body = z
        .object({
          grants: z.array(
            z.object({ groupId: z.string().min(1), role: z.enum(["viewer", "editor"]) })
          ),
        })
        .parse(request.body);
      await setBranchPermissions(branchId, body.grants);
      return reply.send({ ok: true });
    }
  );

  // Remove a single group's grant from a branch.
  app.delete(
    "/api/branches/:branchId/permissions/:groupId",
    { config: { access: { branchParam: "branchId", minRole: "viewer" } } },
    async (request, reply) => {
      const blocked = await manageGuard(request, reply);
      if (blocked) return blocked;
      const { branchId, groupId } = request.params as { branchId: string; groupId: string };
      await removeBranchPermission(branchId, groupId);
      return reply.send({ ok: true });
    }
  );

  // Set branch visibility (public / private / inherit).
  app.put(
    "/api/branches/:branchId/visibility",
    { config: { access: { branchParam: "branchId", minRole: "editor" } } },
    async (request, reply) => {
      const { branchId } = request.params as { branchId: string };
      const body = z.object({ visibility: z.enum(["public", "private", "inherit"]) }).parse(request.body);
      await db.update(branches).set({ visibility: body.visibility }).where(eq(branches.id, branchId));
      return reply.send({ ok: true });
    }
  );
}
