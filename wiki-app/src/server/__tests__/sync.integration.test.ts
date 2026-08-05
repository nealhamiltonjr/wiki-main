import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TEST_DB_PATH = "./data/test-sync.db";
const TEST_REPO_ROOT = "./data/test-sync-repo";
const TEST_FILES_ROOT = "./data/test-sync-files";
const TARGET_DB_PATH = "./data/test-sync-target.db";
const TARGET_REPO_ROOT = "./data/test-sync-target-repo";
const TARGET_FILES_ROOT = "./data/test-sync-target-files";
const AUTH_SECRET = "sy-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENC_KEY = "sy-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

process.env.DB_PATH = TEST_DB_PATH;
process.env.GIT_REPO_ROOT = TEST_REPO_ROOT;
process.env.FILES_ROOT = TEST_FILES_ROOT;
process.env.BETTER_AUTH_SECRET = AUTH_SECRET;
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.SETTINGS_ENCRYPTION_KEY = ENC_KEY;

let app: FastifyInstance;
let target: ChildProcess;
let targetUrl: string;

function extractCookie(h: string | string[] | undefined): string {
  const r = Array.isArray(h) ? h[0] : h;
  return r?.split(";")[0] ?? "";
}

async function sourceSignup(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "pw-" + email, name: "Admin" },
  });
  return extractCookie(res.headers["set-cookie"]);
}

async function sourceCreateSpace(cookie: string, name: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/spaces", headers: { cookie }, payload: { name } });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).id as string;
}

async function targetFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${targetUrl}${path}`, init);
}

async function targetSignup(email: string): Promise<string> {
  const res = await targetFetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "pw-" + email, name: "Admin" }),
  });
  expect(res.status).toBe(200);
  return extractCookie(res.headers.get("set-cookie") ?? undefined);
}

async function targetCreateSpace(cookie: string, name: string): Promise<string> {
  const res = await targetFetch("/api/spaces", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return (await res.json() as { id: string }).id;
}

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  for (const p of [TEST_DB_PATH, TEST_REPO_ROOT, TEST_FILES_ROOT, TARGET_DB_PATH, TARGET_REPO_ROOT, TARGET_FILES_ROOT]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TEST_DB_PATH }, stdio: "pipe" });
  execSync("npx drizzle-kit push --force", { env: { ...process.env, DB_PATH: TARGET_DB_PATH }, stdio: "pipe" });

  // Boot the second (target) instance in a child process so sync runs against a
  // real remote server, with its own DB and git repo.
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, "helpers", "sync-target-server.ts");
  target = spawn(process.execPath, ["--import", "tsx", entry], {
    env: {
      ...process.env,
      DB_PATH: TARGET_DB_PATH,
      GIT_REPO_ROOT: TARGET_REPO_ROOT,
      FILES_ROOT: TARGET_FILES_ROOT,
      BETTER_AUTH_SECRET: AUTH_SECRET,
      BETTER_AUTH_URL: "http://localhost:3000",
      SETTINGS_ENCRYPTION_KEY: ENC_KEY,
      TARGET_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  targetUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for target server")), 20_000);
    target.stdout?.on("data", (chunk: Buffer) => {
      const m = chunk.toString().match(/TARGET_URL=(\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    target.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`target server exited early with code ${code}`));
    });
    target.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  });

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (target && !target.killed) {
    target.kill("SIGTERM");
    await new Promise((resolve) => target.on("exit", resolve));
  }
  for (const p of [
    TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_REPO_ROOT, TEST_FILES_ROOT,
    TARGET_DB_PATH, `${TARGET_DB_PATH}-wal`, `${TARGET_DB_PATH}-shm`, TARGET_REPO_ROOT, TARGET_FILES_ROOT,
  ]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

let adminCookie: string;
let targetCookie: string;
let apiToken: string;

beforeAll(async () => {
  adminCookie = await sourceSignup("sync-admin@example.com");
  targetCookie = await targetSignup("sync-target-admin@example.com");

  // Create an account-scoped API token ON the target so sync's probe + create
  // calls authenticate there.
  const tokenRes = await targetFetch("/api/tokens", {
    method: "POST",
    headers: { cookie: targetCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ scopeType: "account", scopeId: null, permission: "edit", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  });
  expect(tokenRes.status).toBe(201);
  apiToken = (await tokenRes.json() as { token: string }).token;
});

describe("space sync (UI overhaul A5 title round-trip)", () => {
  it("creates a matching page on the target with the real title column", async () => {
    // Target space (on the separate instance) and a same-named source space.
    await targetCreateSpace(targetCookie, "Sync Space");
    const sourceSpace = await sourceCreateSpace(adminCookie, "Sync Space");

    // Source page with an explicit title and body content (no H1).
    const createRes = await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie: adminCookie },
      payload: { slug: "sync-page", title: "Sync Title", spaceId: sourceSpace, parentBranchId: null },
    });
    expect(createRes.statusCode).toBe(201);

    const syncRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${sourceSpace}/sync`,
      headers: { cookie: adminCookie },
      payload: { targetUrl, targetToken: apiToken },
    });
    expect(syncRes.statusCode).toBe(200);
    const body = JSON.parse(syncRes.body);
    expect(body.ok).toBe(true);
    expect(body.synced).toBe(1);
    expect(body.errors).toEqual([]);

    // The target instance now contains the page with the source's real title.
    const getPageRes = await targetFetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_pages", arguments: { query: "sync-page" } },
      }),
    });
    const searchJson = await getPageRes.json() as any;
    expect(searchJson.error).toBeUndefined();
    const hits = JSON.parse(searchJson.result.content[0].text);
    const page = hits.find((h: any) => h.slug === "sync-page");
    expect(page).toBeTruthy();
    expect(page.title).toBe("Sync Title");
  });

  it("supports dry-run without touching the target", async () => {
    await targetCreateSpace(targetCookie, "Dry Space");
    const sourceSpace = await sourceCreateSpace(adminCookie, "Dry Space");

    await app.inject({
      method: "POST",
      url: "/api/pages",
      headers: { cookie: adminCookie },
      payload: { slug: "dry-page", title: "Dry Title", spaceId: sourceSpace, parentBranchId: null },
    });

    const syncRes = await app.inject({
      method: "POST",
      url: `/api/spaces/${sourceSpace}/sync`,
      headers: { cookie: adminCookie },
      payload: { targetUrl, targetToken: apiToken, dryRun: true },
    });
    const body = JSON.parse(syncRes.body);
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.synced).toBe(1);
  });
});
