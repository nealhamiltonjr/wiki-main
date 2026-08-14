import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.DB_PATH = "data/test-file-cleanup.db";
process.env.GIT_REPO_ROOT = "data/test-file-cleanup-repo";

let purgePage: typeof import("../page.service.js").purgePage;
let getDb: typeof import("../../db/index.js").getDb;
let users: typeof import("../../db/schema.js").users;
let spaces: typeof import("../../db/schema.js").spaces;
let branches: typeof import("../../db/schema.js").branches;
let pages: typeof import("../../db/schema.js").pages;
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
  ({ users, spaces, branches, pages } = await import("../../db/schema.js"));
  ({ purgePage } = await import("../page.service.js"));

  await db.insert(users).values({ id: "u-fc", name: "FC", email: "fc@example.com", isAdmin: true });
  await db.insert(spaces).values({ id: "s-fc", name: "FC", createdBy: "u-fc" });
});

afterAll(() => {
  rmSync(process.env.DB_PATH!, { force: true });
  rmSync(`${process.env.DB_PATH}-wal`, { force: true });
  rmSync(`${process.env.DB_PATH}-shm`, { force: true });
});

describe("purgePage file cleanup (slice-53)", () => {
  it("removes the on-disk FILES_ROOT/<pageId>/ directory when the page is purged", async () => {
    const pageId = "p-fc-1";
    const branchId = "b-fc-1";
    await db.insert(pages).values({ id: pageId, slug: "fc-1", title: "FC1", ownerId: "u-fc", content: { type: "doc", content: [] } });
    await db.insert(branches).values({ id: branchId, pageId, parentBranchId: null, spaceId: "s-fc", visibility: "inherit", isSystem: false, createdBy: "u-fc" });

    // Stage a tiny file directory mirroring what storeFile would write.
    const { FILES_ROOT } = await import("../file.service.js");
    const pageDir = path.join(FILES_ROOT, pageId);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(path.join(pageDir, "stub.txt"), "stub");

    expect(existsSync(path.join(pageDir, "stub.txt"))).toBe(true);

    await purgePage(pageId);

    // The cascade deleted the page row; the on-disk dir is also gone.
    const [row] = await db.select().from(pages).where(eq(pages.id, pageId));
    expect(row).toBeUndefined();
    expect(existsSync(pageDir)).toBe(false);
  });

  it("does not delete the FILES_ROOT itself if the page directory was somehow absent", async () => {
    const pageId = "p-fc-2";
    const branchId = "b-fc-2";
    await db.insert(pages).values({ id: pageId, slug: "fc-2", title: "FC2", ownerId: "u-fc", content: { type: "doc", content: [] } });
    await db.insert(branches).values({ id: branchId, pageId, parentBranchId: null, spaceId: "s-fc", visibility: "inherit", isSystem: false, createdBy: "u-fc" });

    const { FILES_ROOT } = await import("../file.service.js");
    // No directory was ever created — purgePage must still succeed and FILES_ROOT survives.
    expect(existsSync(FILES_ROOT)).toBe(true);

    await expect(purgePage(pageId)).resolves.toBeUndefined();
  });
});
