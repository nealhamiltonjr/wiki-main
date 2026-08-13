import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { UserContext } from "../../../shared/types.js";

const DB_PATH = `data/test-relation-unit-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-relation-unit-repo-${randomBytes(4).toString("hex")}`;
process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({ "/sign-up/*": false, "/sign-in/*": false });

beforeAll(() => {
  mkdirSync("./data", { recursive: true });
});

afterAll(async () => {
  const { closeDb } = await import("../../db/index.js");
  closeDb();
  rmSync(DB_PATH, { force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

function asUserCtx(id: string, isAdmin: boolean, groupIds: string[] = []): UserContext {
  return { id, isAdmin, groupIds, capabilities: [], spaceRoles: {} };
}

async function makeUser(id: string, email: string, isAdmin: boolean): Promise<void> {
  const { getDb } = await import("../../db/index.js");
  const { user } = await import("../../db/auth-schema.js");
  const now = new Date();
  await getDb().db
    .insert(user)
    .values({
      id,
      name: id,
      email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
      isAdmin,
      suspended: false,
    })
    .onConflictDoNothing();
}

interface Scaff {
  spaceId: string;
  pageId: string;
  branchId: string;
}

async function scaffoldSpaceAndPage(
  userId: string,
  sfx: string,
  title: string,
): Promise<Scaff> {
  const { getDb } = await import("../../db/index.js");
  const { pages, branches, spaces, spaceMembers } = await import("../../db/schema.js");
  const db = getDb().db;
  const spaceId = `sp-${sfx}`;
  const pageId = `pg-${sfx}`;
  const branchId = `br-${sfx}`;
  const now = new Date();
  await db
    .insert(spaces)
    .values({
      id: spaceId,
      name: `S-${sfx}`,
      createdBy: userId,
      defaultRole: "editor",
      createdAt: now,
    })
    .onConflictDoNothing();
  // Creator is auto-admin in their own space (mirrors space.service.ts
  // createSpace behavior). Without this row, canEditPage would 403 the
  // scaffold-owner.
  await db
    .insert(spaceMembers)
    .values({ spaceId, userId, role: "admin" })
    .onConflictDoNothing();
  await db
    .insert(pages)
    .values({
      id: pageId,
      title,
      slug: `s-${sfx}-p`,
      ownerId: userId,
      content: { type: "doc", content: [{ type: "paragraph" }] } as never,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await db
    .insert(branches)
    .values({
      id: branchId,
      pageId,
      spaceId,
      parentBranchId: null,
      createdBy: userId,
      isSystem: false,
      position: 0,
      createdAt: now,
    })
    .onConflictDoNothing();
  return { spaceId, pageId, branchId };
}

async function addMember(userId: string, spaceId: string, role: "viewer" | "editor"): Promise<void> {
  const { getDb } = await import("../../db/index.js");
  const { spaceMembers } = await import("../../db/schema.js");
  await getDb().db
    .insert(spaceMembers)
    .values({ spaceId, userId, role })
    .onConflictDoUpdate({
      target: [spaceMembers.spaceId, spaceMembers.userId],
      set: { role },
    });
}

describe("relation service (brief §13.1)", () => {
  it("creates and lists an owned relation", async () => {
    const u = "u-owner-" + randomBytes(3).toString("hex");
    await makeUser(u, `${u}@x.com`, false);
    const a = await scaffoldSpaceAndPage(u, "a" + randomBytes(2).toString("hex"), "A");
    const b = await scaffoldSpaceAndPage(u, "b" + randomBytes(2).toString("hex"), "B");
    const { addRelation, listOwnedRelations } = await import("../relation.service.js");
    const rel = await addRelation(
      { fromPageId: a.pageId, type: "depends on", toPageId: b.pageId },
      asUserCtx(u, false),
    );
    expect(rel.target?.id).toBe(b.pageId);

    const owned = await listOwnedRelations(a.pageId, asUserCtx(u, false));
    expect(owned).toHaveLength(1);
    expect(owned[0]!.type).toBe("depends on");
    expect(owned[0]!.target?.title).toBe("B");
  });

  it("filters out unreadable targets from owned lists", async () => {
    const owner = "u-own-" + randomBytes(3).toString("hex");
    const viewer = "u-view-" + randomBytes(3).toString("hex");
    await makeUser(owner, `${owner}@x.com`, false);
    await makeUser(viewer, `${viewer}@x.com`, false);
    const a = await scaffoldSpaceAndPage(owner, "soa-" + randomBytes(2).toString("hex"), "A");
    const bPriv = await scaffoldSpaceAndPage(owner, "sob-" + randomBytes(2).toString("hex"), "B");
    const cShared = await scaffoldSpaceAndPage(owner, "soc-" + randomBytes(2).toString("hex"), "C");
    await addMember(viewer, cShared.spaceId, "viewer");

    const { addRelation, listOwnedRelations } = await import("../relation.service.js");
    await addRelation(
      { fromPageId: a.pageId, type: "depends on", toPageId: bPriv.pageId },
      asUserCtx(owner, false),
    );
    await addRelation(
      { fromPageId: a.pageId, type: "supersedes", toPageId: cShared.pageId },
      asUserCtx(owner, false),
    );

    const out = await listOwnedRelations(a.pageId, asUserCtx(viewer, false));
    expect(out.map((r) => r.type).sort()).toEqual(["supersedes"]);
  });

  it("filters out unreadable sources from incoming lists", async () => {
    const owner = "u-inown-" + randomBytes(3).toString("hex");
    const viewer = "u-inview-" + randomBytes(3).toString("hex");
    await makeUser(owner, `${owner}@x.com`, false);
    await makeUser(viewer, `${viewer}@x.com`, false);
    const aPriv = await scaffoldSpaceAndPage(owner, "ipa-" + randomBytes(2).toString("hex"), "A");
    const bShared = await scaffoldSpaceAndPage(owner, "ipb-" + randomBytes(2).toString("hex"), "B");
    const target = await scaffoldSpaceAndPage(owner, "ipt-" + randomBytes(2).toString("hex"), "T");
    await addMember(viewer, bShared.spaceId, "viewer");

    const { addRelation, listIncomingRelations } = await import("../relation.service.js");
    await addRelation(
      { fromPageId: aPriv.pageId, type: "depends on", toPageId: target.pageId },
      asUserCtx(owner, false),
    );
    await addRelation(
      { fromPageId: bShared.pageId, type: "supersedes", toPageId: target.pageId },
      asUserCtx(owner, false),
    );

    const incoming = await listIncomingRelations(target.pageId, asUserCtx(viewer, false));
    expect(incoming.map((r) => r.source?.id).sort()).toEqual([bShared.pageId]);
  });

  it("admin can list every relation regardless of access", async () => {
    const owner = "u-admown-" + randomBytes(3).toString("hex");
    const admin = "u-adm-" + randomBytes(3).toString("hex");
    await makeUser(owner, `${owner}@x.com`, false);
    await makeUser(admin, `${admin}@x.com`, true);
    const a = await scaffoldSpaceAndPage(owner, "adm-a-" + randomBytes(2).toString("hex"), "A");
    const bPriv = await scaffoldSpaceAndPage(owner, "adm-b-" + randomBytes(2).toString("hex"), "B");

    const { addRelation, listOwnedRelations, listIncomingRelations } = await import(
      "../relation.service.js"
    );
    await addRelation(
      { fromPageId: a.pageId, type: "depends on", toPageId: bPriv.pageId },
      asUserCtx(owner, false),
    );

    const ownedByAdmin = await listOwnedRelations(a.pageId, asUserCtx(admin, true));
    expect(ownedByAdmin).toHaveLength(1);
    const incByAdmin = await listIncomingRelations(bPriv.pageId, asUserCtx(admin, true));
    expect(incByAdmin).toHaveLength(1);
  });

  it("rejects duplicate (page, type, target)", async () => {
    const u = "u-dup-" + randomBytes(3).toString("hex");
    await makeUser(u, `${u}@x.com`, false);
    const a = await scaffoldSpaceAndPage(u, "dup-a-" + randomBytes(2).toString("hex"), "A");
    const b = await scaffoldSpaceAndPage(u, "dup-b-" + randomBytes(2).toString("hex"), "B");
    const { addRelation, RelationValidationError } = await import("../relation.service.js");
    await addRelation(
      { fromPageId: a.pageId, type: "depends on", toPageId: b.pageId },
      asUserCtx(u, false),
    );
    await expect(
      addRelation(
        { fromPageId: a.pageId, type: "depends on", toPageId: b.pageId },
        asUserCtx(u, false),
      ),
    ).rejects.toBeInstanceOf(RelationValidationError);
  });

  it("rejects self-relation", async () => {
    const u = "u-self-" + randomBytes(3).toString("hex");
    await makeUser(u, `${u}@x.com`, false);
    const a = await scaffoldSpaceAndPage(u, "self-" + randomBytes(2).toString("hex"), "A");
    const { addRelation, RelationValidationError } = await import("../relation.service.js");
    await expect(
      addRelation({ fromPageId: a.pageId, type: "self", toPageId: a.pageId }, asUserCtx(u, false)),
    ).rejects.toBeInstanceOf(RelationValidationError);
  });

  it("rejects when caller can't edit the source page", async () => {
    const owner = "u-src-owner-" + randomBytes(3).toString("hex");
    const viewer = "u-src-view-" + randomBytes(3).toString("hex");
    await makeUser(owner, `${owner}@x.com`, false);
    await makeUser(viewer, `${viewer}@x.com`, false);
    const a = await scaffoldSpaceAndPage(owner, "src-a-" + randomBytes(2).toString("hex"), "A");
    const b = await scaffoldSpaceAndPage(owner, "src-b-" + randomBytes(2).toString("hex"), "B");
    await addMember(viewer, a.spaceId, "viewer");
    const { addRelation, RelationValidationError } = await import("../relation.service.js");
    await expect(
      addRelation(
        { fromPageId: a.pageId, type: "depends on", toPageId: b.pageId },
        asUserCtx(viewer, false),
      ),
    ).rejects.toBeInstanceOf(RelationValidationError);
  });

  it("rejects when caller can't read the target page (no target-existence leak)", async () => {
    const owner = "u-tgt-owner-" + randomBytes(3).toString("hex");
    const editor = "u-tgt-edit-" + randomBytes(3).toString("hex");
    await makeUser(owner, `${owner}@x.com`, false);
    await makeUser(editor, `${editor}@x.com`, false);
    const a = await scaffoldSpaceAndPage(owner, "tgt-a-" + randomBytes(2).toString("hex"), "A");
    const hidden = await scaffoldSpaceAndPage(owner, "tgt-h-" + randomBytes(2).toString("hex"), "Hidden");
    // editor can edit source but not the hidden target
    await addMember(editor, a.spaceId, "editor");
    const { addRelation, RelationValidationError, listOwnedRelationsRaw } = await import(
      "../relation.service.js"
    );
    await expect(
      addRelation(
        { fromPageId: a.pageId, type: "depends on", toPageId: hidden.pageId },
        asUserCtx(editor, false),
      ),
    ).rejects.toBeInstanceOf(RelationValidationError);
    // and nothing got persisted
    const raw = await listOwnedRelationsRaw(a.pageId);
    expect(raw).toHaveLength(0);
  });

  it("removeRelation deletes the row and rejects non-editor callers", async () => {
    const owner = "u-rm-owner-" + randomBytes(3).toString("hex");
    const viewer = "u-rm-view-" + randomBytes(3).toString("hex");
    await makeUser(owner, `${owner}@x.com`, false);
    await makeUser(viewer, `${viewer}@x.com`, false);
    const a = await scaffoldSpaceAndPage(owner, "rm-a-" + randomBytes(2).toString("hex"), "A");
    const b = await scaffoldSpaceAndPage(owner, "rm-b-" + randomBytes(2).toString("hex"), "B");
    await addMember(viewer, a.spaceId, "viewer");
    const { addRelation, removeRelation, listOwnedRelationsRaw, RelationValidationError } = await import(
      "../relation.service.js"
    );
    const rel = await addRelation(
      { fromPageId: a.pageId, type: "depends on", toPageId: b.pageId },
      asUserCtx(owner, false),
    );
    // viewer can't delete
    await expect(removeRelation(rel.id, asUserCtx(viewer, false))).rejects.toBeInstanceOf(
      RelationValidationError,
    );
    // owner can
    await removeRelation(rel.id, asUserCtx(owner, false));
    expect(await listOwnedRelationsRaw(a.pageId)).toHaveLength(0);
  });
});