import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";

const TEST_DB_PATH = "./data/test-watchdog.db";

// Set BEFORE any module that imports db/index.js is loaded, so the module-level
// `new Database(...)` in db/index.ts points at this isolated test file rather
// than the real dev database. This is why the db-dependent imports below are
// dynamic (`await import`) instead of static.
process.env.DB_PATH = TEST_DB_PATH;

let db: typeof import("../../db/index.js").db;
let tokens: typeof import("../../db/schema.js").tokens;
let users: typeof import("../../db/schema.js").users;
let runShareLinkWatchdog: typeof import("../token.service.js").runShareLinkWatchdog;

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });

  ({ db } = await import("../../db/index.js"));
  ({ tokens, users } = await import("../../db/schema.js"));
  ({ runShareLinkWatchdog } = await import("../token.service.js"));
});

afterAll(() => {
  if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  if (existsSync(TEST_DB_PATH + "-wal")) rmSync(TEST_DB_PATH + "-wal");
  if (existsSync(TEST_DB_PATH + "-shm")) rmSync(TEST_DB_PATH + "-shm");
});

describe("share link watchdog", () => {
  it("warns three times on inactivity, then auto-revokes and stops touching the link", async () => {
    const { eq } = await import("drizzle-orm");

    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: "watch@example.com", name: "Watch", isAdmin: true, emailVerified: true });

    const tokenId = crypto.randomUUID();
    const THIRTY_ONE_DAYS_AGO = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await db.insert(tokens).values({
      id: tokenId,
      type: "share_link",
      tokenHash: `fake-hash-${tokenId}`,
      createdBy: userId,
      scopeType: "branch",
      scopeId: "fake-branch",
      permission: "view",
      expiresAt: null,
      warningCount: 0,
      createdAt: THIRTY_ONE_DAYS_AGO,
      lastAccessedAt: THIRTY_ONE_DAYS_AGO,
    });

    const warnings: { sweep: number; warningCount: number }[] = [];
    for (let sweep = 1; sweep <= 5; sweep++) {
      await runShareLinkWatchdog((_id, _createdBy, warningCount) => warnings.push({ sweep, warningCount }));
      // Force lastWarningAt back so the next sweep isn't skipped by the
      // "don't re-warn within the window" guard - simulates 5 separate days.
      await db.update(tokens).set({ lastWarningAt: THIRTY_ONE_DAYS_AGO }).where(eq(tokens.id, tokenId));
    }

    expect(warnings.map((w) => w.warningCount)).toEqual([1, 2, 3, 4]);

    const [final] = await db.select().from(tokens).where(eq(tokens.id, tokenId));
    expect(final!.warningCount).toBe(3); // caps here; the 4th sweep revokes instead of incrementing further
    expect(final!.revokedAt).not.toBeNull();
  });

  it("resets the warning count when the link is actually used", async () => {
    const { eq } = await import("drizzle-orm");
    const { resolveToken } = await import("../token.service.js");

    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: "watch2@example.com", name: "Watch2", isAdmin: true, emailVerified: true });

    const tokenId = crypto.randomUUID();
    const THIRTY_ONE_DAYS_AGO = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const rawToken = "test-raw-token-for-reset-check";
    const { createHash } = await import("node:crypto");
    await db.insert(tokens).values({
      id: tokenId,
      type: "share_link",
      tokenHash: createHash("sha256").update(rawToken).digest("hex"),
      createdBy: userId,
      scopeType: "branch",
      scopeId: "fake-branch",
      permission: "view",
      expiresAt: null,
      warningCount: 2, // already partway warned
      createdAt: THIRTY_ONE_DAYS_AGO,
      lastAccessedAt: THIRTY_ONE_DAYS_AGO,
    });

    await resolveToken(rawToken); // a real access

    const [after] = await db.select().from(tokens).where(eq(tokens.id, tokenId));
    expect(after!.warningCount).toBe(0);
    expect(after!.lastAccessedAt!.getTime()).toBeGreaterThan(THIRTY_ONE_DAYS_AGO.getTime());
  });
});
