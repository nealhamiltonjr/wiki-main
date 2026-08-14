import { test, expect, type Page } from "@playwright/test";

// Slice-32 gate — §13.6 dedicated code pages.
//
// Page creation isn't surfaced in the tree UI yet, so (like the trash slice)
// this test drives create through the API and exercises the read + edit
// rendering that DID land in this slice. The page's `request` fixture shares
// the signed-in browser cookie jar, so the API calls authenticate as the same
// e2e user.

const E2E_EMAIL = "e2e@test.local";
const E2E_PASSWORD = "E2ePass-1234";

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
}

async function getActiveSpaceId(page: Page): Promise<string> {
  const res = await page.request.get("/api/spaces");
  expect(res.ok()).toBeTruthy();
  const spaces = (await res.json()) as Array<{ id: string; name: string }>;
  expect(spaces.length).toBeGreaterThan(0);
  return spaces[0]!.id;
}

async function createCodePage(page: Page, spaceId: string, slug: string, language: string) {
  const created = await page.request.post(`/api/spaces/${spaceId}/pages`, {
    data: { slug, title: `Code: ${slug}`, pageType: "code", language },
  });
  expect(created.ok()).toBeTruthy();
  return (await created.json()) as { branchId: string; pageId: string };
}

test("a code page renders highlighted read view and round-trips through the text editor", async ({ page }) => {
  await login(page);
  const spaceId = await getActiveSpaceId(page);
  const uniqueSlug = `code-e2e-${Date.now().toString(36)}`;
  const { branchId } = await createCodePage(page, spaceId, uniqueSlug, "bash");

  // Read view shows the code-page shell (not the rich-text prose container).
  await page.goto(`/w/${branchId}`);
  await expect(page.getByTestId("code-page-read-only")).toBeVisible();

  // Enter edit mode — the code editor is a real textarea.
  await page.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByTestId("code-page-editor");
  await expect(editor).toBeVisible();

  await editor.fill("#!/bin/bash\necho e2e-code-page\n");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });

  // Reload: the raw code survives.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("code-page-read-only")).toBeVisible();
  await expect(page.getByTestId("code-page-read-only")).toContainText("e2e-code-page");
});
