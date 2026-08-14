import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";

process.env.DB_PATH = "data/test-slug-collision.db";
process.env.GIT_REPO_ROOT = "data/test-slug-collision-repo";

let createPage: typeof import("../page.service.js").createPage;
let renamePage: typeof import("../page.service.js").renamePage;
let getDb: typeof import("../../db/index.js").getDb;
let users: typeof import("../../db/schema.js").users;
let spaces: typeof import("../../db/schema.js").spaces;
let branches: typeof import("../../db/schema.js").branches;
let pages: typeof import("../../db/schema.js").pages;
let pageRedirects: typeof import("../../db/schema.js").pageRedirects;
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
  ({ users, spaces, branches, pages, pageRedirects } = await import("../../db/schema.js"));
  ({ createPage, renamePage } = await import("../page.service.js"));

  await db.insert(users).values({ id: "u-sc", name: "SC", email: "sc@example.com", isAdmin: true });
  await db.insert(spaces).values({ id: "s-sc-a", name: "Space A", createdBy: "u-sc" });
  await db.insert(spaces).values({ id: "s-sc-b", name: "Space B", createdBy: "u-sc" });
});

afterAll(() => {
  rmSync(process.env.DB_PATH!, { force: true });
  rmSync(`${process.env.DB_PATH}-wal`, { force: true });
  rmSync(`${process.env.DB_PATH}-shm`, { force: true });
});

describe("page slug uniqueness within a space (slice-54)", () => {
  it("createPage rejects a slug already used by another page in the same space", async () => {
    const first = await createPage({
      slug: "alpha",
      title: "Alpha",
      ownerId: "u-sc",
      spaceId: "s-sc-a",
      parentBranchId: null,
    });
    expect(first.pageId).toBeTruthy();

    await expect(
      createPage({
        slug: "alpha",
        title: "Alpha2",
        ownerId: "u-sc",
        spaceId: "s-sc-a",
        parentBranchId: null,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("createPage allows the same slug in a different space (slugs are per-space)", async () => {
    await expect(
      createPage({
        slug: "alpha",
        title: "AlphaInB",
        ownerId: "u-sc",
        spaceId: "s-sc-b",
        parentBranchId: null,
      }),
    ).resolves.toBeTruthy();
  });

  it("renamePage rejects a destination taken by another page in the same space", async () => {
    const page1 = await createPage({
      slug: "beta-1",
      title: "Beta1",
      ownerId: "u-sc",
      spaceId: "s-sc-a",
      parentBranchId: null,
    });
    const page2 = await createPage({
      slug: "beta-2",
      title: "Beta2",
      ownerId: "u-sc",
      spaceId: "s-sc-a",
      parentBranchId: null,
    });

    await expect(renamePage(page2.pageId, "beta-1")).rejects.toMatchObject({ statusCode: 409 });

    // No redirect was written and the page's slug is still its original.
    const [row] = await db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, page2.pageId));
    expect(row?.slug).toBe("beta-2");
    const redirects = db.select().from(pageRedirects).where(eq(pageRedirects.pageId, page2.pageId)).all();
    expect(redirects).toHaveLength(0);
    void page1;
  });

  it("renamePage allows renaming to the page's own current slug without tripping the collision check", async () => {
    const p = await createPage({
      slug: "gamma",
      title: "Gamma",
      ownerId: "u-sc",
      spaceId: "s-sc-a",
      parentBranchId: null,
    });
    await expect(renamePage(p.pageId, "gamma")).resolves.toBe(true);
  });
});
