import { test, expect, type Page } from "@playwright/test";

// The three editor tests all edit the same seeded "welcome" page. Running them
// in parallel against one shared API server trips OCC conflicts (each save
// carries expectedUpdatedAt), so the file is forced to run serially.
test.describe.configure({ mode: "serial" });

// Slice-5 gate (§6.3 + §11.5): the editor canvas must render exactly one
// bordered ProseMirror container, content typed into it must survive a page
// reload (autosave), and the DOM structure must stay stable across edits.
const E2E_EMAIL = "e2e@test.local";
const E2E_PASSWORD = "E2ePass-1234";

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
}

async function openPage(page: Page, slug: string) {
  // Click the tree item by its accessible name, which includes the slug.
  const node = page.getByRole("treeitem", { name: new RegExp(slug) });
  await node.click();
  await expect(page.locator(".wiki-prose")).toBeVisible();
}

async function enterEditMode(page: Page) {
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

test("editor canvas renders exactly one bordered ProseMirror container", async ({ page }) => {
  await login(page);
  await openPage(page, "welcome");
  await enterEditMode(page);

  // §6.3 gate: exactly one .ProseMirror, and the single writing-surface border
  // lives on the .editor-canvas wrapper (the structural rule — never on focus,
  // selection, or any plugin UI).
  await expect(page.locator(".ProseMirror")).toHaveCount(1);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator(".editor-canvas")).toHaveCount(1);

  const border = await page.locator(".editor-canvas").evaluate((el) => {
    const style = window.getComputedStyle(el);
    return style.borderWidth;
  });
  expect(border).toBeTruthy();
  expect(border).not.toBe("0px");
});

test("typing content survives page reload", async ({ page }) => {
  await login(page);
  await openPage(page, "welcome");
  await enterEditMode(page);

  const editor = page.locator(".ProseMirror");
  await editor.click();
  // Clear existing content and type test text.
  await editor.press("Control+A");
  await editor.press("Backspace");
  await page.keyboard.type("Quick brown fox jumps over the lazy dog.", { delay: 5 });

  // Wait for autosave to land — the footer flips to "Saved" only after the
  // server acknowledged the payload (debounce + network). A fixed sleep is
  // flaky under parallel worker load.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });

  // Reload without navigating away from the page.
  await page.reload({ waitUntil: "networkidle" });

  // After reload we're in read mode — the prose content should show our text.
  const prose = page.locator(".wiki-prose");
  await expect(prose).toBeVisible({ timeout: 10_000 });
  await expect(prose).toContainText("Quick brown fox jumps over the lazy dog.");
});

test("editing existing content preserves DOM structure", async ({ page }) => {
  await login(page);
  await openPage(page, "welcome");
  await enterEditMode(page);

  const editor = page.locator(".ProseMirror");
  // Type a heading then a paragraph.
  await editor.click();
  await editor.press("Control+A");
  await editor.press("Backspace");
  await page.keyboard.type("# Hello World", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("This is a paragraph with **bold** text.", { delay: 5 });

  // Wait for the autosave to land — the footer shows "Saved" only after the
  // server acknowledged the payload (debounce + network). A fixed sleep is
  // flaky under parallel worker load.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });

  // Switch to read mode.
  await page.getByRole("button", { name: "View" }).click();
  const readContent = page.locator(".wiki-prose");

  // Verify heading and paragraph render correctly.
  await expect(readContent.getByRole("heading", { name: "Hello World" })).toBeVisible();
  await expect(readContent.getByText("This is a paragraph with")).toBeVisible();

  // Verify bold text renders.
  const boldEl = readContent.locator("strong").filter({ hasText: "bold" });
  await expect(boldEl.first()).toBeVisible();

  // Back to edit mode — content should still be there.
  await enterEditMode(page);
  await expect(page.locator(".ProseMirror")).toContainText("Hello World");
  await expect(page.locator(".ProseMirror")).toContainText("bold");
});
