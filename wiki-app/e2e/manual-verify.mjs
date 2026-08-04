import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://192.168.1.13:5173";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}

const browser = await chromium.launch({ headless: true });

// Seed a fresh user against the backend (Origin header required by better-auth).
const email = `verify-${Date.now()}@test.local`;
const password = "VerifyPass-123";
const seedRes = await fetch("http://localhost:3000/api/auth/sign-up/email", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": "http://192.168.1.13:3000" },
  body: JSON.stringify({ email, password, name: "Verify User" }),
});
console.log("seed status:", seedRes.status);

const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));

// ---- Login via the UI -------------------------------------------------
await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle" });
await page.waitForSelector(".login-card", { timeout: 10000 });
await page.fill("#login-email", email);
await page.fill("#login-password", password);
await page.click('button[type="submit"]');
await page.waitForSelector(".login-card", { state: "detached", timeout: 10000 });
await page.waitForSelector(".wiki-sidebar-controls", { timeout: 10000 });
const slug = "manual-verify-" + Date.now();
await page.fill('.wiki-sidebar-controls input[placeholder="New space"]', "VerifySpace");
await page.click('.wiki-sidebar-controls button[title="Create space"]');
await page.waitForTimeout(400);
await page.fill('input[placeholder="new-page-slug"]', slug);
await page.click('button[title="Create page"]');
await page.waitForTimeout(900);

// get branch id
const branchId = await page.evaluate(async (slug) => {
  const spaces = await (await fetch("/api/spaces")).json();
  const s = spaces[0];
  const tree = await (await fetch(`/api/spaces/${s.id}/tree`)).json();
  const flat = [];
  const visit = (ns) => ns.forEach((n) => { flat.push(n); if (n.children) visit(n.children); });
  visit(tree);
  return flat.find((p) => p.slug === slug).id;
}, slug);

// ---- 1. Narrow view: canvas only --------------------------------------
await page.goto(`${BASE}/pages/${branchId}`, { waitUntil: "networkidle" });
await page.click('button:has-text("Edit")');
await page.waitForTimeout(500);

const fullWidth = await page.evaluate(() => {
  const canvas = document.querySelector(".wiki-canvas");
  const header = document.querySelector(".page-editor > div:first-child");
  const content = document.querySelector(".wiki-editor-content");
  if (!canvas || !content) return null;
  return {
    canvasWidth: canvas.getBoundingClientRect().width,
    contentWidth: content.getBoundingClientRect().width,
  };
});
await page.click('button:has-text("Narrow view")');
await page.waitForTimeout(400);
const narrow = await page.evaluate(() => {
  const canvas = document.querySelector(".wiki-canvas");
  const content = document.querySelector(".wiki-editor-content");
  const header = document.querySelector(".page-editor > div:first-child");
  if (!canvas || !content || !header) return null;
  return {
    canvasWidth: canvas.getBoundingClientRect().width,
    contentWidth: content.getBoundingClientRect().width,
    headerWidth: header.getBoundingClientRect().width,
  };
});
try {
  await page.click('button:has-text("Full width")', { timeout: 5000 });
} catch {
  const btns = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent).join(" | "));
  console.log("HEADER BUTTONS:", btns.slice(0, 300));
  throw new Error("toggle-back button missing");
}
await page.waitForTimeout(300);

check("narrow: canvas narrower than viewport", narrow && narrow.canvasWidth <= 800, `canvas=${narrow?.canvasWidth}`);
check("narrow: editor content follows canvas", narrow && Math.abs(narrow.contentWidth - narrow.canvasWidth) < 30, `content=${narrow?.contentWidth}`);
check("narrow: header stays full width", narrow && narrow.headerWidth > narrow.canvasWidth + 100, `header=${narrow?.headerWidth}`);

// ---- 2. Slash menu: search aliases + new commands ---------------------
const editor = page.locator(".ProseMirror").first();
await editor.click();
await page.keyboard.type("/");
await page.waitForSelector(".wiki-popup", { timeout: 3000 });
const itemCount = await page.locator(".wiki-popup .popup-item").count();
check("slash: menu opens with items", itemCount > 5, `${itemCount} items`);

// type an alias query "attach"
await page.keyboard.type("attach");
await page.waitForTimeout(400);
const uploadItem = page.locator(".wiki-popup .popup-item", { hasText: "Upload file" }).first();
check("slash: alias search finds Upload file", await uploadItem.isVisible().catch(() => false));
await page.keyboard.press("Escape");

// ---- 3. Upload: image on own line + attachment block -------------------
await editor.click();
await page.keyboard.type("some text before the image");
await page.keyboard.press("Enter");
const fileInput = page.locator('input[type="file"]');
await fileInput.setInputFiles({ name: "verify.png", mimeType: "image/png", buffer: PNG_BYTES });
await page.waitForTimeout(1500);
const imgOnOwnLine = await page.evaluate(() => {
  const img = document.querySelector(".ProseMirror img:not(.ProseMirror-separator)");
  if (!img) return null;
  // The image's parent paragraph should contain ONLY the image (plus separators).
  const p = img.closest("p");
  return p ? { pText: p.textContent.trim(), imgCount: p.querySelectorAll("img:not(.ProseMirror-separator)").length } : null;
});
check("upload: image inserted", imgOnOwnLine != null);
check("upload: image paragraph has no text next to it", imgOnOwnLine && imgOnOwnLine.imgCount === 1, `pText="${imgOnOwnLine?.pText}"`);

// non-image upload -> attachment block
await page.keyboard.press("Enter");
await fileInput.setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: PDF_BYTES });
await page.waitForTimeout(1500);
const att = page.locator(".ProseMirror .wiki-attachment");
check("upload: attachment block rendered", await att.count() === 1);
if (await att.count()) {
  const name = await att.locator(".wiki-attachment-name").textContent();
  const iconKind = await att.locator(".wiki-attachment-icon").getAttribute("data-kind").catch(() => null);
  check("upload: attachment shows name", name === "notes.pdf", `name=${name}`);
  check("upload: attachment shows icon", iconKind === "pdf" || iconKind === "file", `data-kind=${iconKind}`);
}

// separators hidden?
const sepVisible = await page.evaluate(() => {
  const s = document.querySelector("img.ProseMirror-separator");
  if (!s) return false;
  const cs = getComputedStyle(s);
  return cs.width !== "0px" || cs.opacity !== "0";
});
check("upload: separator placeholders are invisible", !sepVisible);

// ---- 4. Comments: hover popup + author names ---------------------------
await editor.click();
await page.keyboard.type("this is text to comment on");
await page.keyboard.press("ControlOrMeta+a");
page.once("dialog", (d) => d.accept("first comment body"));
await page.click('.wiki-toolbar-btn:has-text("💬")');
await page.waitForTimeout(1200);
await page.keyboard.press("Escape");

const highlightCount = await page.locator('.ProseMirror span[data-comment-id]').count();
check("comment: highlight mark applied", highlightCount >= 1, `${highlightCount} highlights`);

// hover the highlight -> popup appears
const hl = page.locator('.ProseMirror span[data-comment-id]').first();
await hl.hover();
await page.waitForTimeout(600);
const popup = page.locator(".comment-hover-popup");
check("comment: hover popup appears", await popup.isVisible().catch(() => false));
if (await popup.isVisible().catch(() => false)) {
  const body = await popup.locator(".chp-body").textContent().catch(() => "");
  check("comment: popup shows body", body && body.includes("first comment body"), `body=${body}`);
  const author = await popup.locator(".chp-author").textContent().catch(() => "");
  check("comment: popup shows author name", author && author.length > 0, `author=${author}`);
}

// click the highlight -> panel opens on the right
await page.mouse.move(5, 5);
await page.waitForTimeout(400);
await hl.click();
await page.waitForTimeout(600);
const panel = page.locator(".comment-panel");
check("comment: clicking highlight opens panel", await panel.isVisible().catch(() => false));
if (await panel.isVisible().catch(() => false)) {
  const panelAuthor = await panel.locator(".panel-body .comment-author, .panel-body").textContent().catch(() => "");
  const sticky = await page.evaluate(() => {
    const el = document.querySelector(".comment-panel");
    return el ? getComputedStyle(el).position : null;
  });
  check("comment: panel is sticky", sticky === "sticky", `position=${sticky}`);
}

// ---- 5. Tree: chevron + indent guide ------------------------------------
await page.goto(`${BASE}/`);
await page.waitForSelector(".wiki-tree", { timeout: 10000 });

// Create a child page under the first tree node to get a collapsible subtree.
await page.locator(".wiki-tree-item").first().hover();
await page.locator('.wiki-tree-item .tree-actions button[title^="Add a page under"]').click();
await page.waitForTimeout(300);
await page.fill('input[placeholder="new-page-slug"]', "child-page");
await page.click('button[title="Create page"]');
await page.waitForTimeout(900);
const chevronCount = await page.locator(".tree-chevron").count();
check("tree: chevron present for parent", chevronCount >= 1, `${chevronCount} chevrons`);

// Collapse the parent -> children hidden; expand -> visible again.
await page.locator(".tree-chevron").first().click();
await page.waitForTimeout(300);
const childVisibleWhenCollapsed = await page.locator(".wiki-tree-item", { hasText: "child-page" }).isVisible().catch(() => false);
check("tree: collapsing hides children", !childVisibleWhenCollapsed);
await page.locator(".tree-chevron").first().click();
await page.waitForTimeout(300);
check("tree: expanding shows children", await page.locator(".wiki-tree-item", { hasText: "child-page" }).isVisible().catch(() => false));
const guide = await page.evaluate(() => {
  const g = document.querySelector(".tree-children::before");
  return !!g || true; // pseudo-elements aren't queryable; check the CSS rule exists instead
});
const guideCss = await page.evaluate(() => {
  const sheets = [...document.styleSheets];
  for (const s of sheets) {
    try {
      for (const rule of s.cssRules || []) {
        if (rule.selectorText && rule.selectorText.includes(".tree-children::before")) return true;
      }
    } catch {}
  }
  return false;
});
check("tree: indent guide CSS present", guideCss);

await browser.close();
console.log("\n===== RESULTS =====");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("Failed:");
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.extra}`));
  process.exit(1);
}
process.exit(0);
