import { test, expect, type Page } from "@playwright/test";

// Slice-19 gate — §12.6 in-page table of contents.
//
// Verifies the end-to-end behaviour of the TOC that the read-mode page view
// renders next to long content:
//   1. The seeded "Getting Started" page has ≥ 2 headings, so the TOC nav
//      renders.
//   2. The TOC lists every top-level heading with the right anchor.
//   3. Clicking a TOC item smooth-scrolls the matching heading into the
//      upper viewport and marks it aria-current="location" so the user
//      knows where they are.
//   4. The TOC does NOT render on pages with fewer than 2 headings (the
//      "Notes" root page is a paragraph-only fixture).

const E2E_EMAIL = "e2e@test.local";
const E2E_PASSWORD = "E2ePass-1234";

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
}

test.describe("§12.6 in-page table of contents", () => {
  test("renders next to a multi-heading page and scrolls to the clicked section", async ({ page }) => {
    // Small viewport so the seeded "Getting Started" page definitely
    // overflows the inner scroll container — required for the
    // click-scroll assertion below to actually observe motion.
    await page.setViewportSize({ width: 1280, height: 500 });
    await login(page);

    // Reset scroll position so the assertion on scroll position is meaningful.
    await page.evaluate(() => window.scrollTo(0, 0));

    // Open "Getting Started" — it has 4 headings (Overview, Installation,
    // Daily usage, Tips) per scripts/seed-e2e.ts. The sidebar tree
    // surfaces the slug, so we click on the slug matching treeitem.
    await page.getByRole("treeitem", { name: /getting-started/ }).click();
    await expect(page.getByTestId("page-toc")).toBeVisible();

    // The TOC lists every heading with the matching anchor. The first
    // heading is the default active entry (aria-current="location").
    const toc = page.getByTestId("page-toc");
    await expect(toc.getByRole("heading", { name: "On this page" })).toBeVisible();
    await expect(toc.locator("a", { hasText: "Overview" })).toHaveAttribute("href", "#gs-overview");
    await expect(toc.locator("a", { hasText: "Installation" })).toHaveAttribute("href", "#gs-install");
    await expect(toc.locator("a", { hasText: "Daily usage" })).toHaveAttribute("href", "#gs-usage");
    await expect(toc.locator("a", { hasText: "Tips" })).toHaveAttribute("href", "#gs-usage-tips");

    // Default active entry is the first heading; deeper ones are not.
    await expect(toc.locator("a", { hasText: "Overview" })).toHaveAttribute("aria-current", "location");
    await expect(toc.locator("a", { hasText: "Tips" })).not.toHaveAttribute("aria-current", "location");

    // The page view (§6.3) renders the content in a scrollable flex
    // child, not at the document root, so the TOC click handler
    // scrolls the inner container (not window). Read the container's
    // scrollTop before the click to detect the smooth-scroll motion.
    const scrollBefore = await page.evaluate(() => {
      const heading = document.getElementById("gs-usage-tips");
      let el: HTMLElement | null = heading;
      while (el && el !== document.body) {
        const s = window.getComputedStyle(el).overflowY;
        if ((s === "auto" || s === "scroll") && el.scrollHeight > el.clientHeight) {
          return el.scrollTop;
        }
        el = el.parentElement;
      }
      return window.scrollY;
    });

    // Click the "Tips" (h3) entry — the deepest heading. The click
    // handler should smooth-scroll the heading into view and mark it
    // aria-current="location" on the next render. Wait for both the
    // scroll and the active-state update.
    await toc.locator("a", { hasText: "Tips" }).click();

    // The smooth-scroll animation completes within ~500ms. We poll
    // until the scroll position advances (or fail after a generous
    // timeout) so a slow CI doesn't flake.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const heading = document.getElementById("gs-usage-tips");
            let el: HTMLElement | null = heading;
            while (el && el !== document.body) {
              const s = window.getComputedStyle(el).overflowY;
              if ((s === "auto" || s === "scroll") && el.scrollHeight > el.clientHeight) {
                return el.scrollTop;
              }
              el = el.parentElement;
            }
            return window.scrollY;
          }),
        { timeout: 3000, intervals: [50, 100, 200] }
      )
      .toBeGreaterThan(scrollBefore);

    // After the click + IntersectionObserver fires, "Tips" becomes the
    // active TOC entry. The previously-active "Overview" loses it.
    await expect(toc.locator("a", { hasText: "Tips" })).toHaveAttribute("aria-current", "location", { timeout: 3000 });
    await expect(toc.locator("a", { hasText: "Overview" })).not.toHaveAttribute("aria-current", "location");

    // URL hash is updated without polluting history.
    await expect(page).toHaveURL(/#gs-usage-tips$/);
  });

  test("does not render on a page with fewer than 2 headings", async ({ page }) => {
    await login(page);

    // "Notes" has no headings (empty doc by default) — the TOC must
    // hide itself to avoid noise.
    await page.getByRole("treeitem", { name: /notes/ }).click();
    await expect(page.getByTestId("page-toc")).toHaveCount(0);
  });
});