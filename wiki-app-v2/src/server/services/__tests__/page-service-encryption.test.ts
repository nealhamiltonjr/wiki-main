import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createEnvelope } from "../../../shared/cryptoEnvelope.js";

// §13.7 server-side contract: the encrypted save path persists a CryptoEnvelope
// verbatim and sets isEncrypted; the read path returns the envelope untouched;
// a normal (unencrypted) save clears the flag and stores plaintext again. The
// server never sees the passphrase or plaintext on the encrypted path.

const TEST_DB_PATH = `data/test-page-encryption-${process.pid}.db`;
process.env.DB_PATH = TEST_DB_PATH;

let savePageOCC: typeof import("../page.service.js").savePageOCC;
let getPageByBranchId: typeof import("../page.service.js").getPageByBranchId;
let db: ReturnType<typeof import("../../db/index.js").getDb>["db"];
let users: typeof import("../../db/schema.js").users;
let spaces: typeof import("../../db/schema.js").spaces;
let branches: typeof import("../../db/schema.js").branches;
let pages: typeof import("../../db/schema.js").pages;

beforeAll(async () => {
  rmSync(TEST_DB_PATH, { recursive: true, force: true });
  mkdirSync("./data", { recursive: true });

  const { closeDb, getDb } = await import("../../db/index.js");
  closeDb();
  db = getDb().db;
  ({ users, spaces, branches, pages } = await import("../../db/schema.js"));
  ({ savePageOCC, getPageByBranchId } = await import("../page.service.js"));

  await db.insert(users).values({ id: "u1", name: "U1", email: "u1@example.com", isAdmin: true });
  await db.insert(spaces).values({ id: "s1", name: "Vault", createdBy: "u1" });
});

afterAll(() => {
  rmSync(TEST_DB_PATH, { force: true });
  rmSync(TEST_DB_PATH + "-wal", { force: true });
  rmSync(TEST_DB_PATH + "-shm", { force: true });
});

async function makePage(pageId: string, branchId: string, content: unknown, isEncrypted = false) {
  await db.insert(pages).values({ id: pageId, slug: pageId, title: pageId, ownerId: "u1", content: content as never, isEncrypted });
  await db.insert(branches).values({ id: branchId, pageId, parentBranchId: null, spaceId: "s1", visibility: "inherit", isSystem: false, createdBy: "u1" });
}

async function pageUpdatedAt(pageId: string): Promise<Date> {
  const [row] = await db.select({ updatedAt: pages.updatedAt }).from(pages).where(eq(pages.id, pageId));
  return row!.updatedAt;
}

describe("per-page encryption service path", () => {
  it("persists a valid envelope verbatim and flags the page", async () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret" }] }] };
    await makePage("p1", "b1", doc);
    const envelope = await createEnvelope(doc, "correct horse battery staple");
    const before = await pageUpdatedAt("p1");

    const result = await savePageOCC({ pageId: "p1", branchId: "b1", content: envelope, expectedUpdatedAt: before, encrypted: true });
    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(pages).where(eq(pages.id, "p1"));
    expect(row!.isEncrypted).toBe(true);
    expect(row!.content).toEqual(envelope);

    const loaded = await getPageByBranchId("b1");
    expect(loaded?.page.isEncrypted).toBe(true);
    expect(loaded?.page.content).toEqual(envelope);
  });

  it("rejects a non-envelope body on the encrypted path", async () => {
    await makePage("p2", "b2", { type: "doc", content: [{ type: "paragraph" }] });
    const before = await pageUpdatedAt("p2");
    const result = await savePageOCC({ pageId: "p2", branchId: "b2", content: { v: 1 }, expectedUpdatedAt: before, encrypted: true });
    expect(result.ok).toBe(false);
    if (!result.ok && "validationErrors" in result) {
      expect(result.validationErrors.length).toBeGreaterThan(0);
    }
  });

  it("clears encryption on a subsequent plaintext (unprotect) save", async () => {
    const doc = { type: "doc", content: [{ type: "paragraph" }] };
    const envelope = await createEnvelope(doc, "another passphrase here");
    await makePage("p3", "b3", envelope, true);
    const afterProtect = await pageUpdatedAt("p3");

    const result = await savePageOCC({ pageId: "p3", branchId: "b3", content: doc, expectedUpdatedAt: afterProtect, encrypted: false });
    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(pages).where(eq(pages.id, "p3"));
    expect(row!.isEncrypted).toBe(false);
    expect(row!.content).toEqual(doc);
  });
});
