import { test, expect, type Page } from "@playwright/test";

// Slice-13 gate (§8 step 13 / §4.6): the two first-party reference plugins are
// pre-installed AND enabled by seed-e2e.ts — a serverRoutes plugin's routes are
// registered at boot (Fastify can't add routes after ready), so pre-seeding is
// the only way the web-clipper's /clip route is live in the e2e server.
// This spec proves the plugins actually WORK in the running editor:
//   1. web clipper — slash command fetches through the plugin's server route
//      and inserts a citation (linked title + blockquote excerpt);
//   2. Draw.io embed — a genuinely NEW content type inserted via slash command,
//      persisted by autosave, and rendered by the plugin's read-only renderer
//      (registerEmbedType) after reload.
// Both edit the seeded "cli" page: editor.spec/slice9.spec use "welcome" and
// plugins.spec uses "notes", so parallel workers can't clobber each other.
const E2E_EMAIL = "e2e@test.local";
const E2E_PASSWORD = "E2ePass-1234";
const CLIP_URL = "http://localhost:5173/"; // the app's own dev front page

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Session gate drops us into the authenticated layout.
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
}

async function openCliEditor(page: Page) {
  await page.getByRole("treeitem", { name: /cli/ }).click();
  await expect(page.locator(".wiki-prose")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await page.locator(".ProseMirror").click();
  // The slash menu only opens at line start / after whitespace.
  await page.keyboard.press("Control+Home");
}

test("web clipper slash command fetches through its server route and inserts a citation", async ({ page }) => {
  await login(page);
  // Handle the plugin's URL prompt (window.prompt) — accept with the clip URL.
  page.on("dialog", (dialog) => dialog.accept(CLIP_URL));
  await openCliEditor(page);

  await page.keyboard.type("/web");
  const slashMenu = page.locator("[data-slash-menu]");
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu.getByRole("button", { name: /Insert web clip/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(slashMenu).toBeHidden();

  // The inserted citation links the clipped title to the source URL, and the
  // blockquote carries the excerpt (index.html has no meta description, so the
  // plugin uses its fallback copy). .first() keeps the assertions unambiguous
  // when a prior run already left a clip on the seeded cli page (repeat runs).
  await expect(page.locator('.ProseMirror a[href="http://localhost:5173/"]').first()).toBeVisible();
  await expect(page.locator(".ProseMirror blockquote").first()).toContainText("No description captured");
});

test("draw.io embed inserts a new content type that renders in edit and read view", async ({ page }) => {
  await login(page);
  await openCliEditor(page);

  await page.keyboard.type("/draw");
  const slashMenu = page.locator("[data-slash-menu]");
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu.getByRole("button", { name: /Insert Draw.io embed/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(slashMenu).toBeHidden();

  // Editor view: the node's renderHTML draws the placeholder box.
  const embed = page.locator(".ProseMirror [data-drawio-embed]").first();
  await expect(embed).toBeVisible();
  await expect(embed).toContainText("New diagram");

  // Persistence: wait for autosave, reload, and confirm the server's content
  // validation accepted the plugin node type (a reject would block the save).
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".wiki-prose")).toBeVisible();

  // Read-only view: the plugin's registerEmbedType renderer paints the embed.
  const readEmbed = page.locator("[data-drawio-embed]").first();
  await expect(readEmbed).toBeVisible();
  await expect(readEmbed).toContainText("New diagram");
  await expect(readEmbed.getByRole("link", { name: "Open in draw.io" })).toBeVisible();
});
