import { test, expect, type Page } from "@playwright/test";

// Slice-4 gate: after signing in, the sidebar renders the seeded demo space's
// tree (react-arborist) with real data from the API — the slug for every
// seeded page, nested under its parent, with the icon attribute rendered.
// The seed lives in scripts/seed-e2e.ts and runs as part of the API webServer.
const E2E_EMAIL = "e2e@test.local";
const E2E_PASSWORD = "E2ePass-1234";

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Session gate drops us into the authenticated layout.
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
}

test("seeded tree renders after login", async ({ page }) => {
  await login(page);

  // The space switcher exposes the seeded space (the select's value is the
  // space UUID; the option text is the human-readable name).
  await expect(page.getByLabel("Active space")).toContainText("Demo Space");

  // Every seeded slug is present as a tree node. Role locators (not getByText)
  // because the node label also carries the page's icon emoji, so exact text
  // won't match — the accessible name is "Collapse <slug>" for parents.
  for (const slug of ["welcome", "notes", "getting-started", "cli"]) {
    await expect(page.getByRole("treeitem", { name: new RegExp(slug) })).toBeVisible();
  }

  // Icons (emoji) from the page's icon attribute render next to slugs.
  await expect(page.getByText("🏠", { exact: true })).toBeVisible();
  await expect(page.getByText("🚀", { exact: true })).toBeVisible();

  // Root branches are in the tree; no system branches or deleted pages leak in.
  // Scope to the tree arborist — the slice-20 sidebar Trash link lives
  // outside the tree, in the sidebar footer (it's a navigation affordance,
  // not a leaked tree node).
  await expect(
    page.getByRole("tree", { name: "Pages tree" }).getByText("Trash", { exact: true })
  ).toHaveCount(0);
});
