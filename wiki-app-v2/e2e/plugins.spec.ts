import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Slice-12 gate (§8 step 12): upload a trivial "hello world" reference plugin
// through the REAL admin UI, confirm it registers, and confirm its effect (a
// slash command) actually works end-to-end in the running editor. Also covers
// the enable toggle and the client-bundle load through the Vite dev proxy.
// This spec mutates shared plugin state, so it runs serially with itself.
test.describe.configure({ mode: "serial" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ZIP = path.resolve(__dirname, "../test-fixtures/hello-world-plugin.zip");

const E2E_EMAIL = "e2e@test.local";
const E2E_PASSWORD = "E2ePass-1234";

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
}

test("admin can upload + enable hello-world through the real UI", async ({ page }) => {
  await login(page);

  // The topbar "Settings" link only renders for admins — confirms the seed user
  // is a global admin so the admin-only plugin route will accept the upload.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/plugins/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Upload the pre-built reference plugin zip. The page reloads itself right
  // after install (the status text is intentionally transient), so wait for the
  // fresh table instead of asserting on it.
  await page.locator('input[type="file"]').setInputFiles(PLUGIN_ZIP);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Hello World Plugin/ })).toBeVisible();
  const row = page.getByRole("row", { name: /Hello World Plugin/ });
  await expect(row.getByText("Disabled")).toBeVisible();

  // Enable it — the toggle reloads the page again.
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const enabledRow = page.getByRole("row", { name: /Hello World Plugin/ });
  await expect(enabledRow.getByText("Enabled")).toBeVisible();
});

test("plugin slash command works end-to-end in the editor", async ({ page }) => {
  await login(page);

  // Open the seeded "notes" page in edit mode. Deliberately NOT "welcome":
  // editor.spec and slice9.spec run in parallel workers and edit the welcome
  // page, and their collab round-trips re-render its editor mid-interaction,
  // which eats the slash-menu Enter. "notes" is untouched by every other spec.
  const node = page.getByRole("treeitem", { name: /notes/ });
  await node.click();
  await expect(page.locator(".wiki-prose")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  // Type "/" at the START of the document — the slash menu only opens at line
  // start or after whitespace. Earlier specs may have typed into this same
  // seeded page, so jump the caret to the doc start rather than clicking the
  // center (which would land mid-text).
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("/");
  const slashMenu = page.locator("[data-slash-menu]");
  await expect(slashMenu).toBeVisible();
  const helloItem = slashMenu.getByRole("button", { name: /Insert Hello World block/ });
  await expect(helloItem).toBeVisible();

  // Run it — the helloWorld node must render in the document. Click the command
  // rather than pressing Enter: Enter runs the FIRST filtered command, and its
  // index depends on plugin registration order (slice-13 pre-seeds web-clipper
  // and drawio-embed before hello-world is uploaded, so they come first).
  await helloItem.click();
  await expect(slashMenu).toBeHidden();
  await expect(page.locator(".ProseMirror [data-hello-world]")).toBeVisible();
  await expect(page.locator(".ProseMirror [data-hello-world]")).toContainText("Hello from plugin!");

  // The content model must accept the plugin node on save (§4.4 extraNodeTypes).
  // Waiting for autosave to quiet down then reloading confirms the server's
  // validateContent let it through — a rejection would surface as a save error.
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".wiki-prose")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".ProseMirror [data-hello-world]")).toBeVisible();
});
