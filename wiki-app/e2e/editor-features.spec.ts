import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A valid 1x1 transparent PNG (used to exercise the real upload path).
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

// Images are inline nodes, so ProseMirror renders invisible `.ProseMirror-separator`
// placeholder <img>s next to them for cursor placement. Match only real images.
const editorImage = (page: import("@playwright/test").Page, scope = ".ProseMirror") =>
  page.locator(`${scope} img:not(.ProseMirror-separator)`);

async function createSpaceAndPage(page: import("@playwright/test").Page, spaceName: string, slug: string) {
  await page.goto("/");
  await page.waitForSelector(".wiki-sidebar-controls", { timeout: 10_000 });

  await page.fill('.wiki-sidebar-controls input[placeholder="New space"]', spaceName);
  await page.click('.wiki-sidebar-controls button[title="Create space"]');
  await expect(page.locator(".wiki-sidebar-controls select")).toContainText(spaceName, { timeout: 5000 });

  await page.waitForTimeout(300);
  // B7: title-first creation dialog. Filling the title auto-derives the slug.
  await page.click('.wiki-sidebar-controls button:has-text("New page")');
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.locator('#page-title').fill(slug);
  await dialog.locator('button:has-text("Create page")').click();
  await page.waitForTimeout(800);
}

// Returns the branch id for a page with the given slug. Searches every space
// (not just spaces[0]) so tests stay correct when earlier tests have created
// spaces/pages in the shared e2e DB.
async function getBranchIdBySlug(page: import("@playwright/test").Page, slug: string): Promise<string> {
  return page.evaluate(async (slug) => {
    const spacesRes = await fetch("/api/spaces");
    const spaces = await spacesRes.json();
    for (const space of spaces) {
      const treeRes = await fetch(`/api/spaces/${space.id}/tree`);
      const tree = await treeRes.json();
      const flat: { id: string; slug: string }[] = [];
      const visit = (nodes: { id: string; slug: string; children: unknown[] }[]) => {
        for (const n of nodes) { flat.push(n); visit(n.children as never); }
      };
      visit(tree);
      const hit = flat.find((p) => p.slug === slug);
      if (hit) return hit.id;
    }
    throw new Error(`No page found for slug "${slug}"`);
  }, slug);
}

async function openEditor(page: import("@playwright/test").Page, slug: string): Promise<import("@playwright/test").Locator> {
  const branchId = await getBranchIdBySlug(page, slug);
  await page.goto(`/pages/${branchId}`, { waitUntil: "networkidle", timeout: 15000 });
  await expect(page.locator(".wiki-page-slug")).toBeVisible({ timeout: 5000 });
  // Editing is the default continuous surface; the Edit button only exists
  // when the page was toggled read-only, so enter editing only if needed.
  const editBtn = page.getByRole("button", { name: "Edit", exact: true });
  if (await editBtn.isVisible().catch(() => false)) {
    await editBtn.click();
  }
  await page.waitForTimeout(300);
  const editor = page.locator(".ProseMirror");
  await editor.click();
  // Clear any existing content so each test starts from a blank paragraph.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
  return editor;
}

test.describe("editor features", () => {
  test.use({ storageState: path.join(__dirname, "auth-admin.json") });

  test("slash menu keyboard selection applies Heading 1", async ({ page }) => {
    await createSpaceAndPage(page, "SlashSpace", "slash-test");
    const editor = await openEditor(page, "slash-test");

    await editor.pressSequentially("/head");
    const h1Item = page.locator('.wiki-popup .popup-item:has-text("Heading 1")').first();
    await expect(h1Item).toBeVisible({ timeout: 4000 });

    await editor.press("Enter");
    await page.waitForTimeout(400);

    // The "/head" text must be gone and an h1 block present.
    await expect(page.locator(".ProseMirror h1")).toHaveCount(1, { timeout: 3000 });
    const text = (await editor.innerText()).trim();
    expect(text).not.toContain("/head");
  });

  test("wiki-link inserts a link without corrupting preceding text", async ({ page }) => {
    await createSpaceAndPage(page, "WikiSpace", "wiki-link-test");
    const editor = await openEditor(page, "wiki-link-test");

    await editor.pressSequentially("Hello ");
    await editor.pressSequentially("[[wiki");
    const firstItem = page.locator(".suggestion-list .suggestion-item").first();
    await expect(firstItem).toBeVisible({ timeout: 4000 });

    await editor.press("Enter");
    await page.waitForTimeout(400);

    // Preceding text survives ("Hello " not eaten), the "[[" is gone, and a
    // link was inserted.
    const text = await editor.innerText();
    expect(text).toContain("Hello ");
    expect(text).not.toContain("[[");
    await expect(page.locator(".ProseMirror a")).toHaveCount(1, { timeout: 3000 });
  });

  test("mention inserts a mention node and saves it", async ({ page }) => {
    await createSpaceAndPage(page, "MentionSpace", "mention-test");
    const editor = await openEditor(page, "mention-test");

    await editor.pressSequentially("@");
    const firstItem = page.locator(".suggestion-list .suggestion-item").first();
    await expect(firstItem).toBeVisible({ timeout: 5000 });

    await editor.press("Enter");
    await page.waitForTimeout(400);
    await expect(page.locator(".ProseMirror .wiki-mention")).toHaveCount(1, { timeout: 3000 });

    // Save and inspect the stored Tiptap JSON for a `mention` node.
    await page.click('button:has-text("Done editing")');
    await page.waitForTimeout(1200);
    const branchId = await getBranchIdBySlug(page, "mention-test");
    const content = await page.evaluate(async (bid) => {
      const res = await fetch(`/api/branches/${bid}/page`, { credentials: "include" });
      if (!res.ok) return { error: res.status };
      return res.json();
    }, branchId);
    const raw = typeof content === "string" ? content : JSON.stringify(content);
    expect(raw).toContain('"type":"mention"');
    expect(raw).toContain('"mentionSuggestionChar":"@"');
  });

  test("toolbar image upload inserts an image", async ({ page }) => {
    await createSpaceAndPage(page, "ImageSpace", "image-test");
    await openEditor(page, "image-test");

    // The hidden file input is what the toolbar's "Upload file" button clicks
    // via triggerUpload(). It is display:none, so assert attachment, then drive
    // the real onChange via setInputFiles.
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached({ timeout: 3000 });
    await fileInput.setInputFiles({ name: "test.png", mimeType: "image/png", buffer: PNG_BYTES });

    await expect(editorImage(page)).toHaveCount(1, { timeout: 8000 });
  });

  test("uploads still work on pages with markdown-imported image content", async ({ page }) => {
    // Regression: the markdown importer stores a standalone `![alt](src)` line
    // as `paragraph > image`. With the image node block-level (extension
    // default) that paragraph was invalid content, so every later insert threw
    // "Called contentMatchAt on a node with invalid content" and file uploads
    // silently did nothing. Images must be inline, so the paragraph stays valid.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await createSpaceAndPage(page, "UploadFixSpace", "upload-fix-test");
    const editor = await openEditor(page, "upload-fix-test");

    // Paste markdown containing a standalone image, exactly as a user would.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "![diagram](/api/branches/fake/files/fake)");
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(".ProseMirror")?.dispatchEvent(ev);
    });
    await expect(editorImage(page)).toHaveCount(1, { timeout: 8000 });

    // Upload a non-image attachment on top of that content. Must insert a real
    // attachment block (icon + name + size; not throw, and not insert literal
    // `[name](url)` text).
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({ name: "spec.pdf", mimeType: "application/pdf", buffer: PDF_BYTES });

    const attachment = page.locator(".ProseMirror .wiki-attachment");
    await expect(attachment).toHaveCount(1, { timeout: 8000 });
    await expect(attachment.locator(".wiki-attachment-name")).toHaveText("spec.pdf");
    expect(errors).toEqual([]);
    void editor;
  });

  test("shared page renders embedded images for an anonymous viewer", async ({ page, browser }) => {
    // Regression for "share link loses the original page's formatting": images
    // in a shared page returned 401 for anonymous viewers (the file endpoint
    // required auth), so the shared page showed broken images. The share route
    // now rewrites image srcs with the share token and the file endpoint
    // accepts it.
    await createSpaceAndPage(page, "ShareImageSpace", "share-image-test");
    const editor = await openEditor(page, "share-image-test");

    // Indented text whose rendering depends on `white-space: break-spaces`.
    // The share page previously dropped that style (Tiptap's injected CSS is
    // removed when the StrictMode double-mount destroys the first editor before
    // EditorContent mounts), collapsing the indentation into "jumbled" prose.
    await page.keyboard.type("#!/bin/bash");
    await page.keyboard.press("Enter");
    await page.keyboard.type("    # indented line");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({ name: "test.png", mimeType: "image/png", buffer: PNG_BYTES });
    await expect(editorImage(page)).toHaveCount(1, { timeout: 8000 });
    void editor;

    await page.click('button:has-text("Done editing")');
    await page.waitForTimeout(1200);

    const branchId = await getBranchIdBySlug(page, "share-image-test");
    const token = await page.evaluate(async (bid) => {
      const res = await fetch(`/api/branches/${bid}/share-links`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopeType: "branch",
          scopeId: bid,
          permission: "view",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`share link creation failed: ${res.status}`);
      return (await res.json()).token as string;
    }, branchId);

    // Anonymous viewer (no storage state) opens the shared page.
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    try {
      await anonPage.goto(`/share/${token}`, { waitUntil: "networkidle", timeout: 15000 });
      await expect(editorImage(anonPage, ".share-page .ProseMirror")).toHaveCount(1, { timeout: 8000 });
      const rendered = await anonPage.evaluate(() => {
        const prose = document.querySelector(".share-page .ProseMirror");
        const img = prose!.querySelector("img:not(.ProseMirror-separator)") as HTMLImageElement;
        const paragraphs = prose!.querySelectorAll("p");
        return {
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          complete: img.complete,
          whiteSpace: getComputedStyle(prose!).whiteSpace,
          // ProseMirror may store leading spaces as non-breaking spaces, so
          // normalize before comparing the indentation.
          indentedText: paragraphs[1] ? paragraphs[1].textContent!.replace(/\u00A0/g, " ") : null,
        };
      });
      expect(rendered.complete).toBe(true);
      expect(rendered.naturalWidth).toBeGreaterThan(0);
      expect(rendered.naturalHeight).toBeGreaterThan(0);
      // Shared pages must keep the editor's whitespace handling: this is the
      // regression that made shared pages look "jumbled" (indentation and space
      // runs collapsed because the tiptap style tag was dropped on the share
      // mount).
      expect(rendered.whiteSpace).toBe("break-spaces");
      expect(rendered.indentedText).toBe("    # indented line");
    } finally {
      await anonContext.close();
    }
  });

  test("drag handle reorders paragraphs without leaving a stuck selection", async ({ page }) => {
    await createSpaceAndPage(page, "DragSpace", "drag-reorder");
    const editor = await openEditor(page, "drag-reorder");

    await page.keyboard.type("Alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Beta");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Gamma");
    // Focusing the editor triggers a one-time layout transition in the page
    // chrome (~0.5s); wait for it to fully settle so every coordinate read
    // below stays valid for the whole synthetic drag.
    await page.waitForTimeout(1200);

    // Move "Beta" below "Gamma" by dragging its block handle. The drag is
    // driven entirely with synthetic events: a real HTML5 drag would open a
    // native DnD session in headless Chromium that swallows synthetic drops.
    const paragraphs = page.locator(".ProseMirror p");
    const betaBox = await paragraphs.nth(1).boundingBox();
    const editorBox = await page.locator(".ProseMirror").first().boundingBox();
    const targetY = editorBox!.y + editorBox!.height - 6;

    const result = await page.evaluate(
      ({ bx, by, tx, ty }) => {
        const pm = document.querySelector(".ProseMirror");
        const h = document.querySelector<HTMLElement>(".drag-handle");
        if (!pm || !h) return { error: "missing editor or handle" };

        // Position the handle over the target paragraph with a synthetic
        // mousemove, then read its rect fresh so the dragstart coordinates
        // match the current layout.
        pm.dispatchEvent(new MouseEvent("mousemove", { clientX: bx + 100, clientY: by, bubbles: true }));
        const hr = h.getBoundingClientRect();
        const hx = hr.x + hr.width / 2;
        const hy = hr.y + hr.height / 2;

        const start = new Event("dragstart", { bubbles: true, cancelable: true });
        start.dataTransfer = {
          clearData() {}, setData() {}, setDragImage() {}, getData() { return ""; },
          effectAllowed: "move", items: { length: 0 }, types: [],
        };
        start.clientX = hx + 50; // handleDragStart offsets by +50+dragHandleWidth
        start.clientY = hy;
        h.dispatchEvent(start);

        const drop = new DragEvent("drop", {
          clientX: tx, clientY: ty, bubbles: true, cancelable: true,
          dataTransfer: new DataTransfer(),
        });
        const dropReturn = pm.dispatchEvent(drop);
        pm.dispatchEvent(new DragEvent("dragend", {
          bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
        }));
        return { dropReturn, prevented: drop.defaultPrevented };
      },
      { bx: betaBox!.x, by: betaBox!.y + betaBox!.height / 2, tx: betaBox!.x + 400, ty: targetY },
    );
    expect(result.error).toBeUndefined();
    // ProseMirror's native drop handler prevents the default action when it
    // performs the move; a regressed custom handler leaves it un-prevented
    // and the paragraph unmoved.
    expect(result.prevented).toBe(true);
    await page.waitForTimeout(300);

    const texts = (await paragraphs.allInnerTexts()).map((t) => t.trim());
    // "Beta" must land at the bottom; a trailing empty paragraph may or may
    // not be rendered depending on the editor config, so only compare the
    // first three blocks.
    expect(texts.slice(0, 3)).toEqual(["Alpha", "Gamma", "Beta"]);
    // The move must not leave a stuck NodeSelection ("blue box"): a click into
    // the text places a normal collapsed caret that accepts typing.
    const alphaBox = await paragraphs.nth(0).boundingBox();
    await page.mouse.click(alphaBox!.x + 20, alphaBox!.y + alphaBox!.height / 2);
    // Let the click settle into a collapsed caret before typing; typing
    // immediately after the synthetic drop can race the selection update.
    await page.waitForTimeout(150);
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.waitForTimeout(200);
    expect((await paragraphs.nth(0).innerText()).trim()).toBe("Alpha!");
  });
});
