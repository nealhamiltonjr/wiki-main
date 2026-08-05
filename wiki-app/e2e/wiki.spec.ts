import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createSpaceAndPage(page: import("@playwright/test").Page, spaceName: string, slug: string) {
  await page.goto("/");
  await page.waitForSelector(".wiki-sidebar-controls", { timeout: 10_000 });

  await page.fill('.wiki-sidebar-controls input[placeholder="New space"]', spaceName);
  await page.click('.wiki-sidebar-controls button[title="Create space"]');
  await expect(page.locator(".wiki-sidebar-controls select")).toContainText(spaceName, { timeout: 5000 });

  await page.waitForTimeout(300);
  // B7: title-first creation dialog. Filling the title auto-derives the slug.
  await page.click('.wiki-sidebar-controls button:has-text("New page")');
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.locator('#page-title').fill(slug);
  await dialog.locator('button:has-text("Create page")').click();
  await page.waitForTimeout(800);
}

// Returns the branch id for a page with the given slug. Searches every space
// (not just spaces[0]) so tests stay correct when earlier tests have created
// spaces/pages in the shared e2e DB. Falls back to the first tree node only if
// no slug matches.
async function getFirstBranchId(page: import("@playwright/test").Page, slug?: string): Promise<string> {
  return page.evaluate(async (slug) => {
    const spacesRes = await fetch("/api/spaces");
    const spaces = await spacesRes.json();
    for (const space of spaces) {
      const treeRes = await fetch(`/api/spaces/${space.id}/tree`);
      const tree = await treeRes.json();
      const flat: { id: string; slug: string }[] = [];
      const visit = (nodes: { id: string; slug: string; children: unknown[] }[]) => {
        for (const n of nodes) { flat.push(n); visit(n.children as never); }
      };
      visit(tree);
      const hit = slug ? flat.find((p) => p.slug === slug) : flat[0];
      if (hit) return hit.id;
    }
    throw new Error("No pages found");
  }, slug);
}

test.describe("wiki app", () => {
  test.use({ storageState: path.join(__dirname, "auth-admin.json") });

  test("loads and shows the sidebar with spaces", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".wiki-sidebar-controls", { timeout: 10_000 });
    await expect(page.locator(".wiki-sidebar-controls select")).toBeVisible();
  });

  test("creates a space and a page, then navigates to it", async ({ page }) => {
    await createSpaceAndPage(page, "E2E Space", "hello-world");

    const branchId = await getFirstBranchId(page, "hello-world");
    await page.goto(`/pages/${branchId}`, { waitUntil: "networkidle", timeout: 15000 });

    await expect(page.locator(".wiki-page-slug")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".wiki-page-slug")).toContainText("hello-world");
    await expect(page.locator(".wiki-editor-content")).toBeVisible();
  });


  test("edits the page title and it persists without touching the slug", async ({ page }) => {
    await createSpaceAndPage(page, "TitleTest", "title-test");

    const branchId = await getFirstBranchId(page, "title-test");
    await page.goto(`/pages/${branchId}`, { waitUntil: "networkidle", timeout: 15000 });
    await expect(page.locator(".wiki-editor-content")).toBeVisible({ timeout: 5000 });

    // B5: the title input is editable for editors
    const titleInput = page.locator(".wiki-page-title-input");
    await expect(titleInput).toBeVisible();
    await expect(titleInput).not.toHaveAttribute("readonly", "");
    await titleInput.fill("Renamed via E2E");
    await page.keyboard.press("Enter"); // commits + flushes the debounce
    await page.waitForTimeout(1500);

    // Slug stays untouched; title persisted via the API
    await expect(page.locator(".wiki-page-slug")).toContainText("title-test");
    const title = await page.evaluate(async (branchId) => {
      const res = await fetch(`/api/branches/${branchId}/page`);
      return (await res.json()).title;
    }, branchId);
    expect(title).toBe("Renamed via E2E");
  });

  test("sets a page icon and it renders in the sidebar tree", async ({ page }) => {
    await createSpaceAndPage(page, "IconTest", "icon-test");

    const branchId = await getFirstBranchId(page, "icon-test");
    await page.goto(`/pages/${branchId}`, { waitUntil: "networkidle", timeout: 15000 });
    await expect(page.locator(".wiki-editor-content")).toBeVisible({ timeout: 5000 });

    // Open the attributes panel and pick an icon
    await page.click('button[title="Page attributes (labels/tags)"]');
    const iconOption = page.locator('.attr-icon-option[title="🚀"]');
    await expect(iconOption).toBeVisible({ timeout: 5000 });
    await iconOption.click();
    await expect(iconOption).toHaveClass(/active/);

    // The icon appears next to the title and in the sidebar tree
    await expect(page.locator(".wiki-page-icon-large")).toHaveText("🚀", { timeout: 5000 });
    await page.goto("/"); // back to the tree view
    // Pick the space this test created (spaces accumulate across parallel tests).
    await page.selectOption('.wiki-sidebar-controls select', { label: "IconTest" });
    const treeRow = page.locator('.wiki-tree-item[data-slug="icon-test"]');
    await expect(treeRow.locator(".tree-page-icon")).toHaveText("🚀", { timeout: 5000 });
  });

  test("types content, saves, and shows 'Saved' status", async ({ page }) => {
    await createSpaceAndPage(page, "SaveTest", "save-test");

    const branchId = await getFirstBranchId(page, "save-test");
    await page.goto(`/pages/${branchId}`, { waitUntil: "networkidle" });
    await expect(page.locator(".wiki-editor-content")).toBeVisible({ timeout: 5000 });

    // Click Edit to enter editing mode
    await page.click('button:has-text("Edit")');
    await page.waitForTimeout(300);

    // Type in the editor
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await editor.pressSequentially("Hello E2E, this is a test page.");

    // Click Done editing to trigger autosave-like behavior
    await page.click('button:has-text("Done editing")');

    // Wait for 'Saved' status
    await expect(page.locator(".wiki-status")).toContainText("Saved", { timeout: 8000 });
  });

  test("opens Cmd+K search palette", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".wiki-sidebar-controls", { timeout: 10_000 });

    await page.keyboard.press("Control+k");
    const palette = page.locator(".cmd-overlay");
    await expect(palette).toBeVisible({ timeout: 3000 });

    await page.fill(".cmd-input", "test");
    await page.waitForTimeout(500);

    await page.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: 2000 });
  });

  test("opens settings page", async ({ page }) => {
    await page.goto("/");
    // Navigate via sidebar button instead of direct route
    await page.click('button:has-text("Settings")');
    await page.waitForSelector(".settings-page", { timeout: 5000 });
    await expect(page.locator(".settings-page h2")).toContainText("Settings");
  });
});
