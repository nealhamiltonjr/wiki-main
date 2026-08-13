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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "better-auth/crypto";
import { getDb } from "../src/server/db/index.js";
import { users, identities, spaces, spaceMembers, pages, branches, attributes, notifications } from "../src/server/db/schema.js";
import { installPluginFromZip, setPluginEnabled } from "../src/server/services/plugin.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const E2E_USER = { email: "e2e@test.local", password: "E2ePass-1234", name: "E2E Tester" };

// First-party reference plugins (§4.6), pre-installed AND enabled here so the
// API server registers their server routes at boot. Fastify refuses to add
// routes after ready(), so a serverRoutes plugin uploaded mid-run (like the
// slice-12 hello-world) can't get live routes without a restart — pre-seeding
// is the only way the web-clipper's /clip route exists in the e2e server.
const FIRST_PARTY_PLUGINS = [
  { zip: path.resolve(__dirname, "../test-fixtures/web-clipper-plugin.zip"), id: "web-clipper" },
  { zip: path.resolve(__dirname, "../test-fixtures/drawio-embed-plugin.zip"), id: "drawio-embed" },
];

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

  // Install + enable the first-party reference plugins (audit rows reference
  // the seed user, so this must run after the user insert). A duplicate install
  // (plugin rows surviving a re-seed of the same DB) is a 409 — just re-enable.
  for (const { zip, id } of FIRST_PARTY_PLUGINS) {
    try {
      await installPluginFromZip(readFileSync(zip), userId);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 409) throw err;
    }
    await setPluginEnabled(id, true, userId);
  }

  const spaceId = crypto.randomUUID();
  await db.insert(spaces).values({ id: spaceId, name: "Demo Space", createdBy: userId });
  await db.insert(spaceMembers).values({ spaceId, userId, role: "admin" });

  // Root -> child -> grandchild, plus a second root. Slugs and icons match what
  // the tree renders (slug + optional icon attribute).
  const rootA = await makePage(db, "welcome", "Welcome", userId, "🏠");
  const rootB = await makePage(db, "notes", "Notes", userId);
  // Slice-19: give "Getting Started" a real multi-section body so the
  // §12.6 in-page TOC has something to render in e2e. Each heading
  // gets a stable id matching what the editor extension would assign
  // (§7.12 block-id system) so TOC anchors actually resolve. Padding
  // paragraphs after each section make the page tall enough that a
  // small e2e viewport is forced to scroll when navigating between
  // headings — without that, the click-scroll behaviour can't be
  // observed deterministically.
  const paddingParagraph = (n: number) => ({
    type: "paragraph",
    // Explicit id so §7.12's read-time auto-id assignment stays a no-op
    // (otherwise the server logs `content-repair-read` warnings for
    // every paragraph on every fetch — harmless but noisy).
    attrs: { id: `gs-pad-${n}` },
    content: [{ type: "text", text: `Padding paragraph ${n} so the page is long enough to force a scroll during e2e TOC navigation.`.repeat(2) }],
  });
  const gettingStartedContent = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1, id: "gs-overview" }, content: [{ type: "text", text: "Overview" }] },
      { type: "paragraph", attrs: { id: "gs-overview-lead" }, content: [{ type: "text", text: "Welcome to the wiki. This page is a quick orientation." }] },
      paddingParagraph(1), paddingParagraph(2), paddingParagraph(3),
      { type: "heading", attrs: { level: 2, id: "gs-install" }, content: [{ type: "text", text: "Installation" }] },
      { type: "paragraph", attrs: { id: "gs-install-lead" }, content: [{ type: "text", text: "Run npm install and start the dev server." }] },
      paddingParagraph(4), paddingParagraph(5), paddingParagraph(6),
      { type: "heading", attrs: { level: 2, id: "gs-usage" }, content: [{ type: "text", text: "Daily usage" }] },
      { type: "paragraph", attrs: { id: "gs-usage-lead" }, content: [{ type: "text", text: "Sign in, then create a space and start writing." }] },
      paddingParagraph(7), paddingParagraph(8), paddingParagraph(9),
      { type: "heading", attrs: { level: 3, id: "gs-usage-tips" }, content: [{ type: "text", text: "Tips" }] },
      { type: "paragraph", attrs: { id: "gs-usage-tips-lead" }, content: [{ type: "text", text: "Use / for the slash menu and @ to mention teammates." }] },
    ],
  };
  const child = await makePage(db, "getting-started", "Getting Started", userId, "🚀", gettingStartedContent);
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
  icon?: string,
  content?: { type: "doc"; content: unknown[] }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(pages).values({
    id,
    slug,
    title,
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
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
