import { test, expect, type Page } from "@playwright/test";

// Slice-9 gate (§9): comments, favorites, notifications exercised from the UI
// once. Runs against the seeded e2e stack (:5173 → :3000). The seed creates
// the e2e user (admin of Demo Space), a welcome page, and one unread mention
// notification.
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
  const node = page.getByRole("treeitem", { name: new RegExp(slug) });
  await node.click();
  await expect(page.locator(".wiki-prose")).toBeVisible();
}

test("favorites: star toggles in the page header", async ({ page }) => {
  await login(page);
  await openPage(page, "welcome");

  const favorite = page.getByTestId("favorite-button");
  await expect(favorite).toBeVisible();
  await expect(favorite).toHaveAttribute("aria-pressed", "false");

  await favorite.click();
  await expect(favorite).toHaveAttribute("aria-pressed", "true");

  await favorite.click();
  await expect(favorite).toHaveAttribute("aria-pressed", "false");
});

test("comments: add a note, reply, and resolve from the panel", async ({ page }) => {
  await login(page);
  await openPage(page, "welcome");

  await page.getByTestId("comments-toggle").click();
  const panel = page.getByTestId("comments-panel");
  await expect(panel).toBeVisible();

  // Add a note.
  await page.getByTestId("comment-draft").fill("This page needs a review.");
  await page.getByTestId("comment-submit").click();
  await expect(panel.getByTestId("comment-thread")).toContainText("This page needs a review.");

  // Reply to it.
  const thread = panel.getByTestId("comment-thread").first();
  await thread.getByTestId("comment-reply-input").fill("On it.");
  await thread.getByTestId("comment-reply-submit").click();
  await expect(thread).toContainText("On it.");

  // Resolve it.
  await thread.getByTestId("thread-resolve").click();
  await expect(thread.getByTestId("thread-resolved-label")).toBeVisible();
});

test("notifications: bell shows unread badge, dropdown lists the mention, mark-all clears it", async ({ page }) => {
  await login(page);

  // The seeded notification is unread.
  const badge = page.getByTestId("notification-unread-badge");
  await expect(badge).toContainText("1");

  await page.getByTestId("notification-bell-button").click();
  const dropdown = page.getByTestId("notification-dropdown");
  await expect(dropdown).toBeVisible();
  await expect(dropdown.getByTestId("notification-row")).toContainText("welcome");

  await dropdown.getByTestId("notifications-mark-all").click();
  await expect(badge).toBeHidden();
});
