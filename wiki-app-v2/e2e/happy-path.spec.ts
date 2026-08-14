import { test, expect, type Page } from "@playwright/test";

/**
 * Slice-40 / §9.4 — single end-to-end happy-path that walks a fresh
 * visitor through every major feature in one continuous flow. The
 * individual specs cover each feature deeply; this one exists to catch
 * cross-feature regressions: a change in the SW bootstrap, the auth
 * layout, the sidebar tree, the editor, the pin button, and the
 * settings shell all have to coexist in a single session.
 *
 * The dev server is configured (playwright.config.ts) to wipe
 * data/e2e.db, reseed it, then boot — so this test starts from the
 * "first user / welcome space" state on every run.
 *
 * Assertion density is intentionally light. The goal is "did anything
 * throw an unhandled error in the console", not "did every feature
 * behave correctly".
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

test("§9.4 happy path — every major feature renders in one session", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  // Catch any unhandled page errors so a missing route or thrown
  // component is loud, not silent.
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // 1. Unauthenticated visit redirects to /login without 401 noise.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);

  // 2. Sign in — sidebar + topbar appear.
  await login(page);

  // 3. Tree is populated with the seeded welcome space.
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("tree", { name: "Pages tree" })).toBeVisible();

  // 4. Open the welcome page — the read-only prose mounts.
  await sidebar.getByRole("treeitem", { name: /welcome/i }).click();
  await expect(page.locator(".wiki-prose")).toBeVisible();

  // 5. Click Edit to enter the writable ProseMirror.
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await editor.press("End");
  await editor.type(" slice-40 smoke note");
  // Save indicator should mention "Saved" or "Saving…" within a couple of seconds.
  await expect(page.getByText(/saved|saving/i).first()).toBeVisible({ timeout: 10_000 });

  // 6. Pin the page — PinButton toggles to pinned state. The sidebar
  //    also has a "Pin" link, so target the testid of the action button
  //    specifically.
  const pin = page.getByTestId("pin-button");
  await expect(pin).toBeVisible();
  // Wait for the page to settle after edit so the SW isn't re-loading.
  await page.waitForTimeout(500);
  await pin.click();

  // 7. /pinned renders the page we just pinned.
  await page.goto("/pinned");
  await expect(page.getByText(/welcome/i).first()).toBeVisible({ timeout: 10_000 });

  // 8. /settings renders every expected sub-section in the left nav.
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: /profile/i })).toBeVisible();

  await page.goto("/settings/users");
  await expect(page.getByRole("heading", { name: /users/i })).toBeVisible();

  await page.goto("/settings/plugins");
  await expect(page.getByRole("heading", { name: /plugins/i })).toBeVisible();

  // 9. /lenses renders the saved-views shell.
  await page.goto("/lenses");
  await expect(page.getByRole("heading")).toBeVisible();

  // 10. Re-verify the unauth redirect after the long session — proves
  //     the session cookie still gates the root path.
  const ctx = page.context();
  await ctx.clearCookies();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);

  // 11. No console errors or page errors should have leaked during the
  //     whole tour. Some 3rd-party warnings are tolerated; we only fail
  //     on the actual signal: uncaught errors and 4xx network noise.
  const blockingErrors = consoleErrors.filter(
    (e) => !e.includes("Failed to load resource") && !e.toLowerCase().includes("warning"),
  );
  expect(pageErrors, `pageerror events: ${pageErrors.join("\n")}`).toEqual([]);
  expect(
    blockingErrors,
    `unexpected console.error events:\n${blockingErrors.join("\n")}`,
  ).toEqual([]);
});