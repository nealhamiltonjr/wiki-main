import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { UserContext } from "../../../shared/types.js";

const DB_PATH = `data/test-lens-unit-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-lens-unit-repo-${randomBytes(4).toString("hex")}`;
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

async function makeUser(id: string, email: string): Promise<void> {
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
      isAdmin: false,
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
  ownerId: string | null,
): Promise<Scaff> {
  const { getDb } = await import("../../db/index.js");
  const { pages, branches, spaces } = await import("../../db/schema.js");
  const db = getDb().db;
  const spaceId = `sp-${sfx}`;
  const pageId = `pg-${sfx}`;
  const branchId = `br-${sfx}`;
  const now = new Date();
  // Schema requires pages.ownerId NOT NULL. Fall back to the creating user
  // when the test asks for an "unowned" page — ownerScope tests then
  // exercise a different code path by using a known different owner.
  const effectiveOwner = ownerId ?? userId;
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
  await db
    .insert(pages)
    .values({
      id: pageId,
      title,
      slug: `s-${sfx}-p`,
      ownerId: effectiveOwner,
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

async function attachTag(pageId: string, tag: string, sfx: string): Promise<void> {
  const { getDb } = await import("../../db/index.js");
  const { attributes } = await import("../../db/schema.js");
  const now = new Date();
  await getDb().db.insert(attributes).values({
    id: `at-${sfx}-${randomBytes(2).toString("hex")}`,
    pageId,
    name: "tag",
    value: tag,
    isPromoted: false,
    position: 0,
    createdAt: now,
  });
}

describe("lens.service — criteria evaluation (brief §12.4)", () => {
  it("matches by tag", async () => {
    const ownerId = "u-tag-owner";
    await makeUser(ownerId, `tag-${randomBytes(3).toString("hex")}@x.com`);
    const sfx = randomBytes(4).toString("hex");
    const { pageId } = await scaffoldSpaceAndPage(ownerId, sfx, "Tagged Page", ownerId);
    await attachTag(pageId, "proxmox", sfx);

    const { runLens, createLens } = await import("../lens.service.js");
    const caller = asUserCtx(ownerId, true);
    const lens = await createLens({
      ownerId: caller.id,
      name: "proxmox-lens",
      criteria: { tags: ["proxmox"] },
    });
    const hits = await runLens(lens, caller);
    expect(hits.map((h) => h.pageId)).toEqual([pageId]);
  });

  it("intersects multiple criteria: tag AND titleRegex", async () => {
    const ownerId = "u-multi";
    await makeUser(ownerId, `multi-${randomBytes(3).toString("hex")}@x.com`);
    const sfx = randomBytes(4).toString("hex");
    const yes = await scaffoldSpaceAndPage(ownerId, `y-${sfx}`, "Proxmox Guide", ownerId);
    await scaffoldSpaceAndPage(ownerId, `nt-${sfx}`, "Proxmox Guide 2", ownerId);
    await scaffoldSpaceAndPage(ownerId, `nm-${sfx}`, "Random Note", ownerId);
    await attachTag(yes.pageId, "proxmox", sfx);

    const { runLens, createLens } = await import("../lens.service.js");
    const caller = asUserCtx(ownerId, true);
    const lens = await createLens({
      ownerId: caller.id,
      name: "tag+regex",
      criteria: { tags: ["proxmox"], titleRegex: "Proxmox Guide$" },
    });
    const hits = await runLens(lens, caller);
    expect(hits.map((h) => h.pageId)).toEqual([yes.pageId]);
  });

  it("returns empty for criteria with no matches", async () => {
    const id = "u-empty";
    await makeUser(id, `empty-${randomBytes(3).toString("hex")}@x.com`);
    const { runLens, createLens } = await import("../lens.service.js");
    const caller = asUserCtx(id, true);
    const lens = await createLens({
      ownerId: caller.id,
      name: "miss",
      criteria: { tags: ["definitely-not-a-real-tag-xyzzy"] },
    });
    const hits = await runLens(lens, caller);
    expect(hits).toEqual([]);
  });

  it("filters by owner=self using UserContext id", async () => {
    const meId = "u-self-me";
    const otherId = "u-self-other";
    await makeUser(meId, `self-me-${randomBytes(3).toString("hex")}@x.com`);
    await makeUser(otherId, `self-other-${randomBytes(3).toString("hex")}@x.com`);
    const sfx = randomBytes(4).toString("hex");
    const mine = await scaffoldSpaceAndPage(meId, `mine-${sfx}`, "Mine Page", meId);
    await scaffoldSpaceAndPage(meId, `theirs-${sfx}`, "Their Page", otherId);

    const { runLens, createLens } = await import("../lens.service.js");
    const lens = await createLens({
      ownerId: meId,
      name: "self",
      criteria: { ownerScope: "self" },
    });
    // Admin bypasses per-space scoping so the criteria test stays focused on
    // the owner filter; access-control tests live in the integration suite.
    const hits = await runLens(lens, asUserCtx(meId, true));
    expect(hits.map((h) => h.pageId)).toEqual([mine.pageId]);
  });

  it("filters by owner=group via user_groups membership", async () => {
    const memberId = "u-grp-member";
    const nonMemberId = "u-grp-outsider";
    await makeUser(memberId, `grp-m-${randomBytes(3).toString("hex")}@x.com`);
    await makeUser(nonMemberId, `grp-nm-${randomBytes(3).toString("hex")}@x.com`);
    const { getDb } = await import("../../db/index.js");
    const { groups, userGroups } = await import("../../db/schema.js");
    const sfx = randomBytes(4).toString("hex");
    const groupId = `grp-${sfx}`;
    const now = new Date();
    await getDb().db.insert(groups).values({ id: groupId, name: `G-${sfx}`, createdAt: now }).onConflictDoNothing();
    await getDb().db.insert(userGroups).values({ userId: memberId, groupId }).onConflictDoNothing();

    const yes = await scaffoldSpaceAndPage(memberId, `gy-${sfx}`, "Group Page", memberId);
    await scaffoldSpaceAndPage(memberId, `gn-${sfx}`, "Outsider", nonMemberId);

    const { runLens, createLens } = await import("../lens.service.js");
    const lens = await createLens({
      ownerId: memberId,
      name: "group",
      criteria: { ownerScope: { kind: "group", groupId } },
    });
    const hits = await runLens(lens, asUserCtx(memberId, true, [groupId]));
    expect(hits.map((h) => h.pageId)).toEqual([yes.pageId]);
  });

  it("respects includeTrash=false by default; includeTrash=true reveals soft-deleted pages", async () => {
    const ownerId = "u-trash";
    await makeUser(ownerId, `trash-${randomBytes(3).toString("hex")}@x.com`);
    const sfx = randomBytes(4).toString("hex");
    const live = await scaffoldSpaceAndPage(ownerId, `live-${sfx}`, "Live", ownerId);
    const trash = await scaffoldSpaceAndPage(ownerId, `trash-${sfx}`, "Trash", ownerId);

    const { getDb } = await import("../../db/index.js");
    const { pages } = await import("../../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await getDb().db.update(pages).set({ deletedAt: new Date() }).where(eq(pages.id, trash.pageId));

    const { runLens, createLens } = await import("../lens.service.js");
    const caller = asUserCtx(ownerId, true);

    const lensDefault = await createLens({
      ownerId: caller.id,
      name: "no-trash",
      criteria: { titleRegex: "^(Live|Trash)$" },
    });
    expect((await runLens(lensDefault, caller)).map((h) => h.pageId)).toEqual([live.pageId]);

    const lensWithTrash = await createLens({
      ownerId: caller.id,
      name: "with-trash",
      criteria: { titleRegex: "^(Live|Trash)$", includeTrash: true },
    });
    expect((await runLens(lensWithTrash, caller)).map((h) => h.pageId).sort()).toEqual([live.pageId, trash.pageId].sort());
  });

  it("rejects invalid titleRegex at evaluation time", async () => {
    const id = "u-bad";
    await makeUser(id, `bad-${randomBytes(3).toString("hex")}@x.com`);
    const { runLens, createLens } = await import("../lens.service.js");
    const caller = asUserCtx(id, true);
    const lens = await createLens({
      ownerId: caller.id,
      name: "bad",
      criteria: { titleRegex: "[" }, // unclosed character class
    });
    await expect(runLens(lens, caller)).rejects.toThrow(/invalid regex/);
  });

  it("shareToken is generated for unlisted, cleared on visibility change, regenerated on transition back", async () => {
    const id = "u-share";
    await makeUser(id, `share-${randomBytes(3).toString("hex")}@x.com`);
    const { createLens, updateLens, getLens } = await import("../lens.service.js");
    const lens = await createLens({
      ownerId: id,
      name: "shared-lens",
      criteria: {},
      visibility: "unlisted",
    });
    expect(lens.shareToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const turned = await updateLens(lens.id, { visibility: "private" });
    expect(turned?.shareToken).toBeNull();

    const back = await updateLens(lens.id, { visibility: "unlisted" });
    expect(back?.shareToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const privateAgain = await updateLens(lens.id, { visibility: "private" });
    expect(privateAgain?.shareToken).toBeNull();
    const reminted = await updateLens(lens.id, { visibility: "unlisted" });
    expect(reminted?.shareToken).not.toBe(back?.shareToken);

    const fetched = await getLens(lens.id);
    expect(fetched?.shareToken).toBe(reminted?.shareToken);
  });
});
