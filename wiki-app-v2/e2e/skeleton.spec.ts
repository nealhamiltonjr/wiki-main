import { test, expect, type Page } from "@playwright/test";

// Slice 1 gate: the app shell boots with ZERO console errors and renders the
// authenticated layout (no session gating exists yet in the skeleton).
function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test("app loads with zero console errors", async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto("/", { waitUntil: "networkidle" });

  // Shell chrome renders.
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await expect(page.getByText("Knowledge Base")).toBeVisible();

  // Health route is reachable and renders.
  await page.goto("/health", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();

  await page.waitForTimeout(300);
  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
