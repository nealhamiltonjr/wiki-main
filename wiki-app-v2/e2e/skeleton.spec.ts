import { test, expect, type Page } from "@playwright/test";

// Slice-4 gate: the login surface loads with ZERO console errors, and an
// unauthenticated visitor to "/" is redirected to /login by the session gate
// (slice-2 backend + slice-4 UI). The tree itself is covered in tree.spec.ts.
function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test("unauthenticated visitors are sent to /login", async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto("/", { waitUntil: "networkidle" });

  // Session gate redirects to the login surface.
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();

  await page.waitForTimeout(300);
  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
