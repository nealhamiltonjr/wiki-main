import { randomUUID } from "node:crypto";
import { eq, count } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, spaces, spaceMembers, pages, branches, attributes } from "../db/schema.js";

// Slice-18 — first-boot bootstrap. The rebuild deliberately ships without a
// production-data migration (§11.1 dropped per user direction: the prior DB
// held only test data); the trade-off is that a fresh install must be made
// walkable by the very first person to hit it, without anyone shelling into
// the server to run a CLI.
//
// Two responsibilities live here:
//
//  1. First-user-is-admin — `isFirstUser()` answers "are there zero users
//     right now?" so the better-auth `databaseHooks.user.create.before`
//     hook in `auth/config.ts` can flip `isAdmin` on the row about to be
//     inserted. Without this, a fresh install locks everyone out of
//     settings because no one can be promoted without an existing admin.
//
//  2. Welcome space seed — `seedWelcomeSpace(ownerId)` materializes the
//     §11.6 "small seed/smoke-test dataset" so a fresh install has
//     something to look at instead of an empty tree. Idempotent: if any
//     space already exists, returns null without touching the DB. The
//     new admin owns the Welcome space; subsequent users see it via
//     whatever access the admin grants (none, by default — it's their
//     personal seed, not a shared demo).
//
// Both are deliberately tiny. The e2e seed in scripts/seed-e2e.ts does
// the heavier job (installs first-party plugins, sets up the demo
// notification); this file is just "make a fresh deploy survivable
// without operator intervention."

/** True iff the user table is currently empty. Called from the better-auth
 *  before-create hook so the first sign-up can be promoted to admin
 *  atomically (no race window between check and insert: the hook is
 *  inside the adapter's create-with-hooks transaction). */
export async function isFirstUser(): Promise<boolean> {
  const { db } = getDb();
  const row = await db.select({ n: count() }).from(users);
  return (row[0]?.n ?? 0) === 0;
}

interface SeededSpace {
  spaceId: string;
  rootBranchIds: { welcome: string; notes: string };
  pageIds: { welcome: string; notes: string; gettingStarted: string; cliReference: string };
}

/** Seeds the §11.6 Welcome space for the just-created admin. Returns null if
 *  a space already exists (idempotent — concurrent first sign-ups or a
 *  second invocation after a restart must not duplicate the tree).
 *
 *  Concurrency note: the count-check + insert pair runs inside a single
 *  sync `db.transaction`. better-sqlite3 acquires the write lock at BEGIN
 *  and holds it for the duration, so a second concurrent caller blocks on
 *  BEGIN until the first commits; by then the count check inside the second
 *  transaction sees 1 and returns null. Previously this used a non-
 *  transactional `select().count()` followed by individual inserts, which
 *  let two concurrent first sign-ups both observe count=0 and both insert a
 *  Welcome space — see the slice-41 regression test in
 *  bootstrap.integration.test.ts. */
export async function seedWelcomeSpace(ownerId: string): Promise<SeededSpace | null> {
  const { db } = getDb();
  return db.transaction((tx) => {
    const row = tx.select({ n: count() }).from(spaces).get();
    if ((row?.n ?? 0) > 0) return null;

    const spaceId = randomUUID();
    tx.insert(spaces).values({
      id: spaceId,
      name: "Welcome",
      createdBy: ownerId,
      // Open to other authenticated users by default so collaboration isn't
      // accidentally locked behind "members only". The admin can tighten this
      // in /settings if they want.
      defaultRole: "editor",
    }).run();
    tx.insert(spaceMembers).values({ spaceId, userId: ownerId, role: "admin" }).run();

    const welcomeId = makePage(tx, ownerId, "welcome", "Welcome", "🏠");
    const notesId = makePage(tx, ownerId, "notes", "Notes");
    const gettingStartedId = makePage(tx, ownerId, "getting-started", "Getting Started", "🚀");
    const cliReferenceId = makePage(tx, ownerId, "cli", "CLI Reference");

    const welcomeBranchId = makeBranch(tx, spaceId, ownerId, welcomeId, null, 0);
    const notesBranchId = makeBranch(tx, spaceId, ownerId, notesId, null, 1);
    const gettingStartedBranchId = makeBranch(tx, spaceId, ownerId, gettingStartedId, welcomeBranchId, 0);
    makeBranch(tx, spaceId, ownerId, cliReferenceId, gettingStartedBranchId, 0);

    return {
      spaceId,
      rootBranchIds: { welcome: welcomeBranchId, notes: notesBranchId },
      pageIds: {
        welcome: welcomeId,
        notes: notesId,
        gettingStarted: gettingStartedId,
        cliReference: cliReferenceId,
      },
    };
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["db"]["transaction"]>[0]>[0];

function makePage(tx: Tx, ownerId: string, slug: string, title: string, icon?: string): string {
  const id = randomUUID();
  tx.insert(pages).values({ id, slug, title, ownerId }).run();
  if (icon) {
    tx.insert(attributes).values({ pageId: id, name: "icon", value: icon }).run();
  }
  return id;
}

function makeBranch(
  tx: Tx,
  spaceId: string,
  createdBy: string,
  pageId: string,
  parentBranchId: string | null,
  position: number,
): string {
  const id = randomUUID();
  tx.insert(branches).values({ id, spaceId, pageId, parentBranchId, position, createdBy }).run();
  return id;
}

/** Re-exported for tests so they can assert "is this the user the bootstrap
 *  promoted?" without re-deriving it from email. */
export async function getUserByEmail(email: string) {
  const { db } = getDb();
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}
