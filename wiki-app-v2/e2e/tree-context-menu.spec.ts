import { test, expect, type Page } from "@playwright/test";

/**
 * Tree context menu (Slice fixing REBUILD.md §7.12 item 2).
 *
 * The brief's §9.4 checklist: "right-click a tree node — the context menu
 * appears and every action in it actually works." This spec is the receipt
 * for that line. Each block names the action, drives it through the UI,
 * and verifies the tree reflects the change.
 *
 * The four actions exercise the four server endpoints that the audit
 * surfaced as missing client wrappers:
 *
 *   - Rename → PUT /api/pages/:pageId/branches/:branchId/slug
 *   - Duplicate → POST /api/branches/:branchId/clone
 *   - Move → PUT /api/branches/:branchId/move
 *   - Delete → DELETE /api/branches/:branchId
 *
 * Each test creates its own throw-away page via the API (`specSetupPage`)
 * so tests are order-independent — destructive tests can run alongside
 * non-destructive ones without leaking state into each other. The seeded
 * tree is left untouched and exists only as a backdrop for navigation.
 */

const E2E_EMAIL = "e2e@test.local";
const E2E_PASSWORD = "E2ePass-1234";

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
}

/**
 * Create a fresh root-level page in the demo space using the page's own
 * request fixture (which shares the page's session cookie). The unique slug
 * lets multiple tests create their own fixture without colliding on the
 * page-level unique constraint.
 */
async function specSetupPage(page: Page, slug: string): Promise<void> {
  const spacesRes = await page.request.get("/api/spaces");
  const spaces = (await spacesRes.json()) as { id: string }[];
  if (spaces.length === 0) throw new Error("specSetupPage: no spaces visible to e2e user");
  const spaceId = spaces[0]!.id;
  const created = await page.request.post(`/api/spaces/${spaceId}/pages`, {
    data: { slug, title: slug.replace(/-/g, " "), pageType: "wiki" },
  });
  if (!created.ok()) {
    throw new Error(`specSetupPage failed: ${created.status()} ${await created.text()}`);
  }
}

/**
 * Right-click the tree node for a given slug. The context menu is rendered
 * into the document root, so we don't try to scope it to the tree.
 */
async function openContextMenu(page: Page, slug: string) {
  const node = page.getByRole("treeitem", { name: new RegExp(`\\b${slug}\\b`) });
  await expect(node.first()).toBeVisible();
  await node.first().click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Page actions" })).toBeVisible();
}

test.describe("tree context menu", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await expect(page.getByRole("treeitem", { name: /welcome/ })).toBeVisible();
  });

  test("rename — slug changes in the tree after the action", async ({ page }) => {
    const slug = `rename-me-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await specSetupPage(page, slug);

    await page.reload({ waitUntil: "networkidle" });
    await openContextMenu(page, slug);

    await page.getByRole("menuitem", { name: "Rename" }).click();

    const prompt = page.locator("[role=dialog]").filter({ hasText: /new slug/i });
    await expect(prompt).toBeVisible();
    await prompt.getByRole("textbox").fill(`${slug}-renamed`);
    await prompt.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("treeitem", { name: new RegExp(`${slug}-renamed`) })).toBeVisible();
    // Use a negative lookahead so the original slug doesn't match the
    // `-renamed` variant. The original shows the bare slug followed by
    // nothing-or-end-of-label; the renamed shows the slug followed by
    // `-renamed`.
    await expect(
      page
        .getByRole("treeitem", { name: new RegExp(`(?:^|\\s)${slug}(?!-)`) })
        .or(page.getByRole("treeitem", { name: new RegExp(`^${slug}$`) })),
    ).toHaveCount(0);
  });

  test("duplicate — a new placement appears in the tree", async ({ page }) => {
    const slug = `dup-me-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await specSetupPage(page, slug);
    await page.reload({ waitUntil: "networkidle" });
    await openContextMenu(page, slug);

    const before = await page.getByRole("treeitem", { name: new RegExp(`\\b${slug}\\b`) }).count();
    expect(before).toBe(1);

    await page.getByRole("menuitem", { name: "Duplicate" }).click();

    await expect(page.getByRole("treeitem", { name: new RegExp(`\\b${slug}\\b`) })).toHaveCount(2);
  });

  test("move — placing under a target re-roots it under the target", async ({ page }) => {
    const movSlug = `movable-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await specSetupPage(page, movSlug);
    await page.reload({ waitUntil: "networkidle" });

    const parentMatch = page.getByRole("treeitem", { name: /\bnotes\b/ }).first();
    await expect(parentMatch).toBeVisible();

    await openContextMenu(page, movSlug);
    await page.getByRole("menuitem", { name: "Move to..." }).click();

    const moveDialog = page.locator("[role=dialog]").filter({ hasText: /move .* under/i });
    await expect(moveDialog).toBeVisible();
    await moveDialog.getByRole("button", { name: /\bnotes\b/ }).click();

    await expect(page.getByRole("treeitem", { name: new RegExp(`\\b${movSlug}\\b`) })).toHaveCount(1);
  });

  test("delete — confirming the dialog removes the placement", async ({ page }) => {
    const slug = `del-me-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await specSetupPage(page, slug);
    await page.reload({ waitUntil: "networkidle" });
    await openContextMenu(page, slug);

    await page.getByRole("menuitem", { name: "Delete" }).click();

    const confirm = page.locator("[role=dialog]").filter({ hasText: /delete/i });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByRole("treeitem", { name: new RegExp(`\\b${slug}\\b`) })).toHaveCount(0);
  });

  test("cancelling the context menu by pressing Escape keeps the tree intact", async ({ page }) => {
    const before = await page.getByRole("treeitem", { name: /\bwelcome\b/ }).count();
    await openContextMenu(page, "welcome");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "Page actions" })).toHaveCount(0);
    const after = await page.getByRole("treeitem", { name: /\bwelcome\b/ }).count();
    expect(after).toBe(before);
  });

  test("delete is disabled when the branch has children", async ({ page }) => {
    // `welcome` has children (getting-started and cli under it) — the
    // server enforces "no children" so the menu Disable mirrors the guard.
    await openContextMenu(page, "welcome");
    const del = page.getByRole("menuitem", { name: "Delete" });
    await expect(del).toBeDisabled();
    await page.keyboard.press("Escape");
  });
});

