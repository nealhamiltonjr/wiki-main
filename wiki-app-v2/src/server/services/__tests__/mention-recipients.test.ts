import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";

process.env.DB_PATH = "data/test-mention-recipients.db";
process.env.GIT_REPO_ROOT = "data/test-mention-recipients-repo";

let getDb: typeof import("../../db/index.js").getDb;
let processMentions: typeof import("../mention.service.js").processMentions;
let getNotifications: typeof import("../notification.service.js").getNotifications;
let users: typeof import("../../db/schema.js").users;
let spaces: typeof import("../../db/schema.js").spaces;
let spaceMembers: typeof import("../../db/schema.js").spaceMembers;
let pages: typeof import("../../db/schema.js").pages;
let branches: typeof import("../../db/schema.js").branches;
let db: ReturnType<typeof getDb>["db"];

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [
    process.env.DB_PATH!,
    `${process.env.DB_PATH}-wal`,
    `${process.env.DB_PATH}-shm`,
  ]) {
    rmSync(p, { recursive: true, force: true });
  }
  ({ getDb } = await import("../../db/index.js"));
  db = getDb().db;
  ({ users, spaces, spaceMembers, pages, branches } = await import("../../db/schema.js"));
  ({ processMentions } = await import("../mention.service.js"));
  ({ getNotifications } = await import("../notification.service.js"));

  await db.insert(users).values({ id: "u-mr", name: "MR", email: "mr@example.com", isAdmin: true });
  await db.insert(users).values({ id: "u-victim", name: "Victim", email: "v@example.com" });
  await db.insert(spaces).values({ id: "s-mr", name: "Author Space", createdBy: "u-mr" });
  await db.insert(pages).values({ id: "p-mr-1", slug: "p1", title: "P1", ownerId: "u-mr", content: { type: "doc", content: [] } });
  await db.insert(branches).values({ id: "b-mr-1", pageId: "p-mr-1", parentBranchId: null, spaceId: "s-mr", visibility: "inherit", isSystem: false, createdBy: "u-mr" });
});

afterAll(() => {
  rmSync(process.env.DB_PATH!, { force: true });
  rmSync(`${process.env.DB_PATH}-wal`, { force: true });
  rmSync(`${process.env.DB_PATH}-shm`, { force: true });
});

describe("processMentions recipient filter (slice-55)", () => {
  it("drops mentions for users who aren't members of any space the page lives in", async () => {
    // u-victim is NOT a member of s-mr. The mention must be filtered.
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "u-victim", label: "V" } },
          ],
        },
      ],
    };
    await processMentions("p-mr-1", "b-mr-1", "p1", "u-mr", content);
    const items = await getNotifications("u-victim");
    expect(items).toHaveLength(0);
  });

  it("delivers the mention once u-victim joins a space the page lives in", async () => {
    await db.insert(spaceMembers).values({ spaceId: "s-mr", userId: "u-victim", role: "viewer" });
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "u-victim", label: "V" } },
          ],
        },
      ],
    };
    await processMentions("p-mr-1", "b-mr-1", "p1", "u-mr", content);
    const items = await getNotifications("u-victim");
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.kind).toBe("mention");
  });

  it("drops mentions for non-existent users", async () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "u-ghost", label: "G" } },
          ],
        },
      ],
    };
    // Should be a no-op (no rows inserted, no crash).
    await expect(processMentions("p-mr-1", "b-mr-1", "p1", "u-mr", content)).resolves.toBeUndefined();
    const ghostItems = await getNotifications("u-ghost");
    expect(ghostItems).toHaveLength(0);
    void eq;
  });
});
