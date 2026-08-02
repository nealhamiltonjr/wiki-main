/**
 * Global setup: seeds test users via the better-auth REST API, then logs in
 * via the browser and saves auth state files so no test needs to log in again.
 */
import { chromium, type FullConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:3000";

const USERS = [
  { email: "admin-e2e@test.local", password: "AdminPass-e2e-123", name: "E2E Admin" },
  { email: "user-e2e@test.local", password: "UserPass-e2e-123", name: "E2E User" },
] as const;

async function seedUsers() {
  for (const u of USERS) {
    // better-auth's CSRF check requires the Origin header to match
    // a trusted origin. The server's own URL is always trusted.
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": BASE },
      body: JSON.stringify(u),
    });
    // 200 = created, 4xx = already exists (harmless)
    const body = await res.text();
    if (!res.ok && res.status !== 400 && res.status !== 409) {
      console.warn(`[setup] seed ${u.email}: ${res.status} ${body}`);
    }
  }
}

async function loginAndSave(
  browser: ReturnType<typeof chromium.launch> extends Promise<infer T> ? T : never,
  email: string,
  password: string,
  outFile: string,
) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto(`${BASE}/#/login`, { waitUntil: "networkidle" });
  await page.waitForSelector(".login-card", { timeout: 10_000 });

  await page.fill("#login-email", email);
  await page.fill("#login-password", password);
  await page.click('button[type="submit"]');

  // Wait for the login card to disappear (sign of successful login + redirect)
  await page.waitForSelector(".login-card", { state: "detached", timeout: 10_000 });
  // Let the session settle so cookies are written
  await page.waitForTimeout(500);
  await ctx.storageState({ path: path.join(__dirname, outFile) });
  await ctx.close();
}

async function globalSetup(_config: FullConfig) {
  // Seed users via the API (fast, no UI flakiness)
  await seedUsers();

  const browser = await chromium.launch({ headless: true });

  // Login as each user and save auth state for tests
  await loginAndSave(browser, USERS[0].email, USERS[0].password, "auth-admin.json");
  await loginAndSave(browser, USERS[1].email, USERS[1].password, "auth-user.json");

  await browser.close();
}

export default globalSetup;
