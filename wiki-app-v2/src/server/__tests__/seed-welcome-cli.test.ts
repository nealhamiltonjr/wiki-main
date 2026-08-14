import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

/**
 * Slice-47 — `npm run seed-welcome` recovery command.
 *
 * The auto-bootstrap is wired through `databaseHooks.user.create.after` in
 * `src/server/auth/config.ts`. If sign-up is bypassed (direct SQL insert,
 * future non-better-auth providers, etc.) the install has a user but no
 * Welcome space. The bootstrap comment promises a manual recovery command;
 * this test pins that command's behavior.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const TEST_DB_PATH = path.resolve(REPO_ROOT, "data/test-seed-welcome-cli.db");

let app: FastifyInstance;

beforeAll(async () => {
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
  // The CLI script reads DB_PATH; spin up the app at the same path so the
  // schema is migrated before the CLI runs against it.
  process.env.DB_PATH = TEST_DB_PATH;
  process.env.BETTER_AUTH_SECRET = "test-only-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  const { closeDb } = await import("../db/index.js");
  const { resetAuth } = await import("../auth/config.js");
  closeDb();
  resetAuth();
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

function runSeedWelcome(): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", "scripts/seed-welcome.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, DB_PATH: TEST_DB_PATH },
      encoding: "utf-8",
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status: number | null; stdout: Buffer | string };
    return {
      status: e.status ?? 1,
      stdout: typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "",
    };
  }
}

describe("npm run seed-welcome recovery command (slice-47)", () => {
  it("exits non-zero with a clear message when the DB has no users", () => {
    const result = runSeedWelcome();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/no users in DB/);
  });

  it("seeds the §11.6 Welcome tree for the first admin when no space exists", async () => {
    // Drop a user directly via SQL — bypasses better-auth, so the auto-bootstrap
    // never runs. This is exactly the failure mode the recovery command is for.
    // `users` (db/schema.ts) is a re-export of better-auth's `user` (auth-schema.ts),
    // so a single insert hits both names.
    const { getDb } = await import("../db/index.js");
    const { db } = getDb();
    const { users } = await import("../db/schema.js");
    db.insert(users).values({
      id: "recovery-user-1",
      name: "Recovery Admin",
      email: "recovery-1@example.com",
      emailVerified: true,
      isAdmin: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    const result = runSeedWelcome();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/seeded Welcome space/);

    const { spaces, branches, pages, spaceMembers } = await import("../db/schema.js");
    const spacesRows = await db.select().from(spaces);
    expect(spacesRows).toHaveLength(1);
    expect(spacesRows[0]!.name).toBe("Welcome");
    expect(await db.select().from(branches)).toHaveLength(4);
    expect(await db.select().from(pages)).toHaveLength(4);
    const membership = await db.select().from(spaceMembers).where(eq(spaceMembers.userId, "recovery-user-1"));
    expect(membership).toHaveLength(1);
    expect(membership[0]!.role).toBe("admin");
  });

  it("is idempotent: re-running against a seeded install is a no-op", () => {
    const result = runSeedWelcome();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/already exists/);
  });
});