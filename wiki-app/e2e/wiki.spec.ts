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
  await page.fill('input[placeholder="new-page-slug"]', slug);
  await page.click('button[title="Create page"]');
  await page.waitForTimeout(800);
}

async function getFirstBranchId(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async () => {
    const spacesRes = await fetch("/api/spaces");
    const spaces = await spacesRes.json();
    const space = spaces[0];
    if (!space) throw new Error("No spaces found");
    const treeRes = await fetch(`/api/spaces/${space.id}/tree`);
    const tree = await treeRes.json();
    if (!tree[0]) throw new Error("No pages in tree");
    return tree[0].id as string;
  });
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

    const branchId = await getFirstBranchId(page);
    await page.goto(`/pages/${branchId}`, { waitUntil: "networkidle", timeout: 15000 });

    await expect(page.locator(".wiki-page-slug")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".wiki-page-slug")).toContainText("hello-world");
    await expect(page.locator(".wiki-editor-content")).toBeVisible();
  });


  test("types content, saves, and shows 'Saved' status", async ({ page }) => {
    await createSpaceAndPage(page, "SaveTest", "save-test");

    const branchId = await getFirstBranchId(page);
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
