/**
 * Seeds a reproducible demo dataset for the slice-4 e2e gate: a single test
 * user (created via better-auth's own password hashing so real sign-in works),
 * one space, and a small tree of pages/branches. Uses the exact service/db
 * modules the app runs on, so the tree that Playwright sees is the same shape
 * the server computes for any real user.
 *
 * Run standalone:  npx tsx scripts/seed-e2e.ts
 * (DB_PATH defaults to data/e2e.db - the API server must point at the same file.)
 */
import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { getDb } from "../src/server/db/index.js";
import { users, identities, spaces, spaceMembers, pages, branches, attributes, notifications } from "../src/server/db/schema.js";

export const E2E_USER = { email: "e2e@test.local", password: "E2ePass-1234", name: "E2E Tester" };

export async function seedE2E(): Promise<void> {
  const { db } = getDb();

  // Wipe prior run's seed rows first so the script is idempotent. Spaces cascade
  // to branches (and branches to pages + attributes) via FK onDelete, so
  // removing the user's spaces cleans the whole tree, then the user row itself.
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, E2E_USER.email));
  if (existing) {
    await db.delete(spaces).where(eq(spaces.createdBy, existing.id));
    await db.delete(users).where(eq(users.id, existing.id));
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(E2E_USER.password);
  await db.insert(users).values({
    id: userId,
    name: E2E_USER.name,
    email: E2E_USER.email,
    emailVerified: true,
    // Global admin — the e2e suite exercises admin surfaces (plugin upload in
    // the slice-12 gate, settings IA in slice-14) under this one identity.
    isAdmin: true,
  });
  // better-auth stores the credential password on the account row, not the user
  // row (providerId "credential", accountId = userId) - sign-in verifies there.
  await db.insert(identities).values({
    id: crypto.randomUUID(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: passwordHash,
  });

  const spaceId = crypto.randomUUID();
  await db.insert(spaces).values({ id: spaceId, name: "Demo Space", createdBy: userId });
  await db.insert(spaceMembers).values({ spaceId, userId, role: "admin" });

  // Root -> child -> grandchild, plus a second root. Slugs and icons match what
  // the tree renders (slug + optional icon attribute).
  const rootA = await makePage(db, "welcome", "Welcome", userId, "🏠");
  const rootB = await makePage(db, "notes", "Notes", userId);
  const child = await makePage(db, "getting-started", "Getting Started", userId, "🚀");
  const grandchild = await makePage(db, "cli", "CLI Reference", userId);

  const rootBranchA = await makeBranch(db, spaceId, userId, rootA, null, 0);
  const rootBranchB = await makeBranch(db, spaceId, userId, rootB, null, 1);
  const childBranch = await makeBranch(db, spaceId, userId, child, rootBranchA, 0);
  await makeBranch(db, spaceId, userId, grandchild, childBranch, 0);

  // Slice-9: seed one unread mention notification so the notification bell has
  // something to show without needing a second user + editor mention flow.
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId,
    kind: "mention",
    payload: { slug: "welcome", body: "in welcome" },
  });

  console.log(`[seed] user=${E2E_USER.email} space=${spaceId} root branches=${rootBranchA},${rootBranchB}`);
}

async function makePage(
  db: ReturnType<typeof getDb>["db"],
  slug: string,
  title: string,
  ownerId: string,
  icon?: string
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(pages).values({
    id,
    slug,
    title,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    ownerId,
  });
  if (icon) {
    await db.insert(attributes).values({ pageId: id, name: "icon", value: icon });
  }
  return id;
}

async function makeBranch(
  db: ReturnType<typeof getDb>["db"],
  spaceId: string,
  createdBy: string,
  pageId: string,
  parentBranchId: string | null,
  position: number
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(branches).values({
    id,
    spaceId,
    pageId,
    createdBy,
    parentBranchId,
    position,
  });
  return id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedE2E().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
