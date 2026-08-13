import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

// Slice-18 gate — first-boot bootstrap behavior. Fresh DB → first sign-up
// is auto-promoted to admin AND seeds the §11.6 Welcome space. Subsequent
// sign-ups are normal users with no admin flag and no Welcome duplication.
//
// Uses its own DB (test-bootstrap-<hash>.db) so it doesn't interfere with
// the slice-2 auth test, which also runs against a fresh DB but only
// exercises the first-user path's HTTP shape.

const TEST_DB_PATH = "data/test-bootstrap-integration.db";

process.env.DB_PATH = TEST_DB_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-bootstrap-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

let app: FastifyInstance;

async function signUp(email: string, name: string, password = "test-Pass-1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name, email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-up failed (${res.statusCode}): ${res.body}`);
  }
  return res.json() as { user: { id: string; email: string; isAdmin: boolean }; token: string };
}

beforeAll(async () => {
  mkdirSync("data", { recursive: true });
  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
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

describe("slice-18 gate: first-boot bootstrap", () => {
  it("promotes the first sign-up to admin and seeds the Welcome space", async () => {
    // Exactly zero users in the DB (beforeAll wiped the test DB).
    const { isFirstUser, seedWelcomeSpace } = await import("../services/bootstrap.service.js");
    expect(await isFirstUser()).toBe(true);

    const first = await signUp("founder@example.com", "Founder");

    // First user is admin via the databaseHooks.user.create.before hook.
    expect(first.user.email).toBe("founder@example.com");
    expect(first.user.isAdmin).toBe(true);

    // Welcome space was seeded by the .after hook with the expected tree.
    const seeded = await seedWelcomeSpace(first.user.id);
    expect(seeded).toBeNull(); // idempotency — space already exists from the .after hook

    const { getDb } = await import("../db/index.js");
    const { db } = getDb();
    const { spaces, spaceMembers, branches, pages } = await import("../db/schema.js");

    const spaceRows = await db.select().from(spaces);
    expect(spaceRows).toHaveLength(1);
    const welcomeSpace = spaceRows[0]!;
    expect(welcomeSpace.name).toBe("Welcome");
    expect(welcomeSpace.createdBy).toBe(first.user.id);
    expect(welcomeSpace.defaultRole).toBe("editor"); // open to collaborators by default

    const memberRows = await db.select().from(spaceMembers).where(eq(spaceMembers.userId, first.user.id));
    expect(memberRows).toHaveLength(1);
    const membership = memberRows[0]!;
    expect(membership.role).toBe("admin");
    expect(membership.spaceId).toBe(welcomeSpace.id);

    const branchRows = await db.select().from(branches);
    expect(branchRows).toHaveLength(4); // welcome + notes + getting-started + cli

    const pageRows = await db.select().from(pages);
    expect(pageRows).toHaveLength(4);
    const slugs = pageRows.map((p) => p.slug).sort();
    expect(slugs).toEqual(["cli", "getting-started", "notes", "welcome"]);
  });

  it("does NOT promote the second sign-up and does NOT duplicate the Welcome space", async () => {
    expect(await import("../services/bootstrap.service.js").then((m) => m.isFirstUser())).toBe(false);

    const second = await signUp("second@example.com", "Second User");

    // Second user is just a regular user; the bootstrap already ran.
    expect(second.user.email).toBe("second@example.com");
    expect(second.user.isAdmin).toBe(false);

    // No second Welcome space was created (idempotent seed).
    const { getDb } = await import("../db/index.js");
    const { db } = getDb();
    const { spaces } = await import("../db/schema.js");
    const spaceRows = await db.select().from(spaces);
    expect(spaceRows).toHaveLength(1);
    expect(spaceRows[0]!.name).toBe("Welcome");

    // Second user has NO space membership in the Welcome space — the brief
    // calls this personal, not shared. They get their own space via the
    // /spaces UI when they want one.
    const { spaceMembers } = await import("../db/schema.js");
    const memberRows = await db.select().from(spaceMembers).where(eq(spaceMembers.userId, second.user.id));
    expect(memberRows).toHaveLength(0);
  });

  it("rejects client-supplied isAdmin on sign-up (only the hook grants it)", async () => {
    // additionalFields.isAdmin has input:false, so even attempting to set
    // isAdmin in the payload must not produce an admin. Belt-and-suspenders
    // check against an attacker crafting a sign-up POST.
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        name: "Sneaky",
        email: "sneaky@example.com",
        password: "test-Pass-1234",
        isAdmin: true as unknown as undefined, // extra field that better-auth should strip
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.isAdmin).toBe(false);
  });
});