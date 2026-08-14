/**
 * Recovery command for an empty install: seeds the §11.6 Welcome space
 * (and the four starter pages) for the first user it finds in the DB.
 *
 * Use case: the auto-bootstrap `databaseHooks.user.create.after` lives
 * inside better-auth's create-user adapter path. If a sign-up somehow
 * bypasses that path (a direct SQL insert, an admin-import script, or
 * any future auth provider that doesn't go through the same hook), the
 * install ends up with a user but no Welcome space. This command is the
 * documented repair.
 *
 * Run standalone:
 *   DB_PATH=data/app.db npx tsx scripts/seed-welcome.ts
 *
 * Idempotent: `seedWelcomeSpace` returns null when any space already
 * exists, so re-running is safe.
 */
import { seedWelcomeSpace } from "../src/server/services/bootstrap.service.js";
import { getDb, closeDb } from "../src/server/db/index.js";
import { users } from "../src/server/db/schema.js";
import { eq } from "drizzle-orm";

const { db } = getDb();

const existingSpaces = await db.select({ id: users.id }).from(users);
if (existingSpaces.length === 0) {
  console.log("[seed-welcome] no users in DB — nothing to do (sign-up first to materialize an admin).");
  closeDb();
  process.exit(1);
}

// Prefer the most recent admin; fall back to the first user.
const adminRow = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true));
const ownerId = adminRow[0]?.id ?? existingSpaces[0]!.id;
const ownerEmail = (await db.select({ email: users.email }).from(users).where(eq(users.id, ownerId)))[0]?.email;

const seeded = await seedWelcomeSpace(ownerId);
if (seeded === null) {
  console.log(`[seed-welcome] Welcome space already exists; no changes for owner=${ownerEmail ?? ownerId}.`);
} else {
  console.log(`[seed-welcome] seeded Welcome space ${seeded.spaceId} for owner=${ownerEmail ?? ownerId}.`);
}
closeDb();