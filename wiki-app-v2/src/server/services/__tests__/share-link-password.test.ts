import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";

process.env.DB_PATH = "data/test-share-link-pwd.db";
process.env.GIT_REPO_ROOT = "data/test-share-link-pwd-repo";
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-pppppppppppppppp";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

let createShareLink: typeof import("../token.service.js").createShareLink;
let resolveToken: typeof import("../token.service.js").resolveToken;
let checkTokenPassword: typeof import("../token.service.js").checkTokenPassword;
let getDb: typeof import("../../db/index.js").getDb;
let users: typeof import("../../db/schema.js").users;
let db: ReturnType<typeof getDb>["db"];

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [
    process.env.DB_PATH!,
    `${process.env.DB_PATH}-wal`,
    `${process.env.DB_PATH}-shm`,
  ]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  ({ getDb } = await import("../../db/index.js"));
  db = getDb().db;
  ({ users } = await import("../../db/schema.js"));
  ({ createShareLink, resolveToken, checkTokenPassword } = await import("../token.service.js"));

  await db.insert(users).values({ id: "u-slp-1", name: "SLP", email: "slp-1@example.com", isAdmin: true });
  await db.insert(users).values({ id: "u-slp-2", name: "SLP2", email: "slp-2@example.com", isAdmin: true });
  await db.insert(users).values({ id: "u-slp-3", name: "SLP3", email: "slp-3@example.com", isAdmin: true });
});

afterAll(() => {
  rmSync(process.env.DB_PATH!, { force: true });
  rmSync(`${process.env.DB_PATH}-wal`, { force: true });
  rmSync(`${process.env.DB_PATH}-shm`, { force: true });
});

describe("share-link password hashing (slice-56)", () => {
  it("stores a scrypt$<salt>$<key> tri-tuple, not SHA-256", async () => {
    const { rawToken } = await createShareLink({
      branchOrSpaceId: "b-slp-1",
      scopeType: "branch",
      createdBy: "u-slp-1",
      isAdmin: true,
      permission: "view",
      expiresAt: new Date(Date.now() + 60_000),
      password: "the-password",
    });

    const resolved = await resolveToken(rawToken);
    expect(resolved?.passwordHash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  it("accepts the correct password and rejects wrong guesses (constant-time)", async () => {
    const { rawToken } = await createShareLink({
      branchOrSpaceId: "b-slp-2",
      scopeType: "branch",
      createdBy: "u-slp-2",
      isAdmin: true,
      permission: "view",
      expiresAt: new Date(Date.now() + 60_000),
      password: "correct horse battery staple",
    });
    const resolved = await resolveToken(rawToken);
    expect(resolved).not.toBeNull();

    expect(checkTokenPassword(resolved!, "correct horse battery staple")).toBe(true);
    expect(checkTokenPassword(resolved!, "wrong password guess")).toBe(false);
    expect(checkTokenPassword(resolved!, undefined)).toBe(false);
    expect(checkTokenPassword(resolved!, "")).toBe(false);

    // Passwordless token must short-circuit to true.
    const { rawToken: rawNoPwd } = await createShareLink({
      branchOrSpaceId: "b-slp-3",
      scopeType: "branch",
      createdBy: "u-slp-3",
      isAdmin: true,
      permission: "view",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const resolvedNoPwd = await resolveToken(rawNoPwd);
    expect(checkTokenPassword(resolvedNoPwd!, "anything")).toBe(true);
  });

  it("rejects a stored hash in the legacy SHA-256 format (forces a clean re-install)", () => {
    // A row might have been created by the prior slice (SHA-256 only). The
    // check function must reject any non-scrypt format rather than silently
    // succeed — otherwise the user is locked out with no diagnostic.
    const legacyHash = "deadbeefdeadbeefdeadbeef";
    const resolved = {
      id: "x", type: "share_link" as const, createdBy: "u", scopeType: "branch" as const,
      scopeId: null, permission: "view" as const, passwordHash: legacyHash,
    };
    expect(checkTokenPassword(resolved, "deadbeefdeadbeefdeadbeef")).toBe(false);
  });

  it("rejects a stored hash with the wrong number of segments", () => {
    // Note: the empty-string case is exercised by the passwordless test
    // (checkTokenPassword short-circuits to true) so we don't list it here.
    const cases = ["scrypt", "scrypt$abc", "scrypt$abc$def$extra", "bcrypt$abc$def"];
    for (const h of cases) {
      const resolved = {
        id: "x", type: "share_link" as const, createdBy: "u", scopeType: "branch" as const,
        scopeId: null, permission: "view" as const, passwordHash: h,
      };
      expect(checkTokenPassword(resolved, "any")).toBe(false);
    }
  });
});
