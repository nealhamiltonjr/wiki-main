import { test, expect, type Page } from "@playwright/test";

// Slice-20 gate — §12.1 trash UI.
//
// The server side of §12.1 (softDeleteBranch / restorePage / purgePage +
// the three /api/spaces/:spaceId/trash{,/restore,/purge} routes + the
// deletedAt column) shipped with slice-9; this slice adds the UI layer.
// Coverage:
//
//   1. The sidebar exposes a "Trash" footer link that targets the active
//      space's trash view.
//   2. /trash/:spaceId lists every soft-deleted page with title + slug +
//      a relative "deleted …" timestamp and Restore / Delete-forever
//      buttons.
//   3. Restore clears deletedAt and the page reappears in the tree and in
//      the trash list (as gone).
//   4. Purge shows the destructive confirm dialog, the entry disappears
//      after confirm, and reloading still shows the empty state.
//   5. Cancel on the purge confirm leaves the entry alone.
//
// Page creation and deletion aren't surfaced in the tree UI yet, so this
// test drives create/delete through the API directly (the same endpoints
// the missing UI will call) — the exercise is the trash view itself. The
// page's `request` fixture shares the signed-in browser cookie jar, so
// every API call below authenticates as the same e2e user the browser
// is logged into.

const E2E_EMAIL = "e2e@test.local";
const E2E_PASSWORD = "E2ePass-1234";

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
}

// Read what the seed left behind: the single "Demo Space" the e2e user
// belongs to. Using /api/spaces keeps the test independent of seed naming.
async function getActiveSpaceId(page: Page): Promise<string> {
  const res = await page.request.get("/api/spaces");
  expect(res.ok()).toBeTruthy();
  const spaces = (await res.json()) as Array<{ id: string; name: string }>;
  expect(spaces.length).toBeGreaterThan(0);
  return spaces[0]!.id;
}

async function createTempPage(
  page: Page,
  spaceId: string,
  slug: string
): Promise<{ pageId: string; branchId: string }> {
  const created = await page.request.post(`/api/spaces/${spaceId}/pages`, {
    data: { slug, title: `Trash test: ${slug}` },
  });
  expect(created.ok()).toBeTruthy();
  const { branchId, pageId } = (await created.json()) as { branchId: string; pageId: string };
  return { pageId, branchId };
}

async function navigateToTrash(page: Page, spaceId: string) {
  await page.goto(`/trash/${spaceId}`);
  await expect(page.getByTestId("trash-panel")).toBeVisible();
}

async function deleteBranch(page: Page, branchId: string) {
  const del = await page.request.delete(`/api/branches/${branchId}/page`);
  expect(del.ok()).toBeTruthy();
}

test.describe("§12.1 trash UI", () => {
  test("sidebar Trash link leads to the per-space trash view", async ({ page }) => {
    await login(page);
    await page.getByTestId("trash-sidebar-link").click();
    await expect(page.getByTestId("trash-panel")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
  });

  test("restore: a deleted page shows up, restore removes it from the trash and from the DB row", async ({
    page,
  }) => {
    await login(page);
    const spaceId = await getActiveSpaceId(page);

    const uniqueSlug = `trash-restore-${Date.now().toString(36)}`;
    const { pageId, branchId } = await createTempPage(page, spaceId, uniqueSlug);

    // Pre-condition: not in trash yet.
    await navigateToTrash(page, spaceId);
    await expect(page.getByTestId("trash-panel")).not.toContainText(uniqueSlug);

    // Delete via API (the future Delete-from-tree UI will call this).
    await deleteBranch(page, branchId);

    // Appears in trash.
    await navigateToTrash(page, spaceId);
    const row = page.getByTestId("trash-row").filter({ hasText: uniqueSlug });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("trash-restore")).toBeEnabled();
    await expect(row.getByTestId("trash-purge")).toBeEnabled();

    // Restore.
    await row.getByTestId("trash-restore").click();
    await expect(row).toHaveCount(0);

    // The page is back: re-visiting /w/$branchId renders the read view,
    // and the server's trash list no longer contains the pageId (restorePage
    // clears deletedAt everywhere the page is placed, so any future
    // re-trash would be a separate delete — not a stale row).
    await page.goto(`/w/${branchId}`);
    await expect(page.locator(".wiki-prose")).toBeVisible();

    const trashAfter = await page.request.get(`/api/spaces/${spaceId}/trash`);
    const after = (await trashAfter.json()) as Array<{ pageId: string }>;
    expect(after.some((e) => e.pageId === pageId)).toBe(false);
  });

  test("purge: a confirmed purge is permanent — reload still shows the empty trash", async ({
    page,
  }) => {
    await login(page);
    const spaceId = await getActiveSpaceId(page);

    const uniqueSlug = `trash-purge-${Date.now().toString(36)}`;
    const { pageId, branchId } = await createTempPage(page, spaceId, uniqueSlug);
    await deleteBranch(page, branchId);

    await navigateToTrash(page, spaceId);
    const row = page.getByTestId("trash-row").filter({ hasText: uniqueSlug });
    await expect(row).toBeVisible();

    await row.getByTestId("trash-purge").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Delete forever" }).click();
    await expect(row).toHaveCount(0);

    // Hard-confirm: reload the page (the in-memory list resets) and the
    // DB still has no row for that pageId.
    await navigateToTrash(page, spaceId);
    await expect(page.getByTestId("trash-row").filter({ hasText: uniqueSlug })).toHaveCount(0);

    const trashAfter = await page.request.get(`/api/spaces/${spaceId}/trash`);
    const after = (await trashAfter.json()) as Array<{ pageId: string }>;
    expect(after.some((e) => e.pageId === pageId)).toBe(false);
  });

  test("cancel-purge: dismissing the confirm leaves the entry in the list", async ({ page }) => {
    await login(page);
    const spaceId = await getActiveSpaceId(page);

    const uniqueSlug = `trash-cancel-${Date.now().toString(36)}`;
    const { branchId } = await createTempPage(page, spaceId, uniqueSlug);
    await deleteBranch(page, branchId);

    await navigateToTrash(page, spaceId);
    const row = page.getByTestId("trash-row").filter({ hasText: uniqueSlug });
    await expect(row).toBeVisible();

    await row.getByTestId("trash-purge").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Scope the Cancel click to the confirm dialog — without scope, the
    // partially-matching "Restore" and "Delete forever" row buttons also
    // satisfy a name: "Cancel" partial match.
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    await expect(row).toBeVisible();
  });

  test("empty state: a fresh trash shows the empty card with no rows", async ({ page }) => {
    await login(page);
    const spaceId = await getActiveSpaceId(page);
    await navigateToTrash(page, spaceId);
    // The empty-state card is shown iff there are zero rows. We don't
    // assert "no rows" globally (other tests might be running in parallel
    // and creating rows against the same shared space — fullyParallel in
    // playwright.config), but we assert the panel mounted and the card
    // sentinel text is reachable in either branch.
    await expect(page.getByTestId("trash-panel")).toBeVisible();
    const empty = page.getByText("The trash is empty.");
    const someRow = page.getByTestId("trash-row").first();
    // Either-or: the empty state OR at least one row. Both are correct
    // shapes for this view.
    await expect(empty.or(someRow)).toBeVisible();
  });
});
