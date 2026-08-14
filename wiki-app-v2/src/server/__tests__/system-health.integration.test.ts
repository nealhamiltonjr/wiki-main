/**
 * §11.4 admin observability — verifies the
 * `/api/settings/system-health` aggregate: it returns the recent
 * errors list populated by `recordSystemLog`, the git-flush
 * stamp, queue depths, DB stats, and any plugin currently in a
 * failure streak (slice-34 plumbing).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";

const DB_PATH = `data/test-system-health-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `data/test-system-health-repo-${randomBytes(4).toString("hex")}`;
process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({
  "/sign-up/*": false,
  "/sign-in/*": false,
});

import { getDb } from "../db/index.js";
import { systemSettings, systemLogs, plugins, users } from "../db/schema.js";
import {
  recordSystemLog,
  getRecentErrors,
} from "../services/system-logger.service.js";
import { setPluginEnabled } from "../services/plugin.service.js";

let app: Awaited<ReturnType<typeof import("../app.js").buildApp>>;

let adminCookie: string;
let adminUserId: string;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const cookie = raw?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^better-auth.session_token=/);
  return cookie;
}

beforeAll(async () => {
  mkdirSync("./data", { recursive: true });
  const { buildApp } = await import("../app.js");
  app = await buildApp();
  await app.ready();

  // Real signup + DB-side isAdmin promotion — same pattern as
  // plugin.integration.test.ts: the access middleware reads
  // isAdmin fresh per request, so the existing session picks
  // the promotion up immediately.
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email: "admin@test.invalid", password: "testtest1234", name: "Admin" },
  });
  if (signup.statusCode === 200) {
    adminCookie = extractCookie(signup.headers["set-cookie"]);
  } else {
    const signin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@test.invalid", password: "testtest1234" },
    });
    expect(signin.statusCode).toBe(200);
    adminCookie = extractCookie(signin.headers["set-cookie"]);
  }
  await getDb().db.update(users).set({ isAdmin: true }).where(eq(users.email, "admin@test.invalid"));
  const [u] = await getDb().db.select({ id: users.id }).from(users).where(eq(users.email, "admin@test.invalid"));
  expect(u).toBeTruthy();
  adminUserId = u!.id;
});

afterAll(async () => {
  await app.close();
  const { closeDb } = await import("../db/index.js");
  try { closeDb(); } catch { /* noop */ }
  rmSync(DB_PATH, { force: true });
  rmSync(DB_PATH + "-wal", { force: true });
  rmSync(DB_PATH + "-shm", { force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

describe("§11.4 system observability", () => {
  it("recordSystemLog persists error rows that getRecentErrors can read", async () => {
    const { db } = getDb();
    await db.delete(systemLogs);

    await recordSystemLog({ level: "error", source: "test:smoke", message: "first failure" });
    // a tiny await helps DB serialize the writes so the ordering
    // assertion below is deterministic across schedules.
    await new Promise((r) => setTimeout(r, 5));
    await recordSystemLog({ level: "error", source: "test:smoke", message: "second failure" });
    await recordSystemLog({ level: "info", source: "test:smoke", message: "not error" });

    const rows = await getRecentErrors(20);
    const messages = rows.map((r) => r.message);
    // newest first
    expect(messages[0]).toBe("second failure");
    expect(messages[1]).toBe("first failure");
    // only errors — info rows must NOT leak into the recent-errors list
    expect(rows.every((r) => r.level === "error")).toBe(true);
  });

  it("records the last successful git flush and surfaces it via the health endpoint", async () => {
    const { db } = getDb();
    // Direct upsert into systemSettings — bypasses setSystemSetting's
    // updatedBy FK (which would need a real admin user row) since
    // the health endpoint only reads back the value.
    const before = new Date().toISOString();
    await db
      .insert(systemSettings)
      .values({ key: "last_git_flush_at", value: before, isSecret: false })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: new Date().toISOString(), updatedAt: new Date() },
      });

    const res = await app.inject({
      method: "GET",
      url: "/api/settings/system-health",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.git.lastFlushAt).not.toBeNull();
    expect(new Date(body.git.lastFlushAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime()
    );
  });

  it("flags a recently-failing plugin in the plugins section without listing healthy ones", async () => {
    const { db } = getDb();
    const badId = "broken-plugin-test";
    const okId = "healthy-plugin-test";

    const pluginCaps = {
      tiptapExtensions: false,
      slashCommands: false,
      toolbarItems: false,
      settingsPanel: false,
      embedTypes: false,
      serverRoutes: false,
      hooks: false,
    };

    await db.insert(plugins).values({
      id: badId,
      name: "broken-plugin",
      version: "0.0.1",
      enabled: false,
      capabilities: pluginCaps,
      nodeTypes: [],
      markTypes: [],
      failureCount: 4,
      lastError: "hook handler: kaboom",
      disabledReason: "Auto-disabled after 5 consecutive failures",
    });
    await db.insert(plugins).values({
      id: okId,
      name: "healthy-plugin",
      version: "0.0.1",
      enabled: true,
      capabilities: pluginCaps,
      nodeTypes: [],
      markTypes: [],
      failureCount: 0,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/settings/system-health",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const ids = body.plugins.failing.map((p: { id: string }) => p.id);
    expect(ids).toContain(badId);
    expect(ids).not.toContain(okId);

    const broken = body.plugins.failing.find((p: { id: string }) => p.id === badId);
    expect(broken.autoDisabled).toBe(true);
    expect(broken.failureCount).toBe(4);

    await db.delete(plugins).where(eq(plugins.id, badId));
    await db.delete(plugins).where(eq(plugins.id, okId));
  });

  it("re-enable via setPluginEnabled clears the failure state", async () => {
    // Cross-slice contract: slice-34's failure isolation + slice-35's
    // observability. Once an admin re-enables a tripped plugin, the
    // health panel no longer lists it under "plugins in failure".
    const { db } = getDb();
    const id = "recoverable-plugin-test";
    const pluginCaps = {
      tiptapExtensions: false,
      slashCommands: false,
      toolbarItems: false,
      settingsPanel: false,
      embedTypes: false,
      serverRoutes: false,
      hooks: false,
    };
    await db.insert(plugins).values({
      id,
      name: "recoverable-plugin",
      version: "0.0.1",
      enabled: false,
      capabilities: pluginCaps,
      nodeTypes: [],
      markTypes: [],
      failureCount: 6,
      lastError: "kaboom",
      disabledReason: "Auto-disabled after 5 consecutive failures",
    });

    let res = await app.inject({
      method: "GET",
      url: "/api/settings/system-health",
      headers: { cookie: adminCookie },
    });
    let body = res.json();
    expect(body.plugins.failing.some((p: { id: string }) => p.id === id)).toBe(true);

    await setPluginEnabled(id, true, adminUserId);

    res = await app.inject({
      method: "GET",
      url: "/api/settings/system-health",
      headers: { cookie: adminCookie },
    });
    body = res.json();
    expect(body.plugins.failing.some((p: { id: string }) => p.id === id)).toBe(false);

    await db.delete(plugins).where(eq(plugins.id, id));
  });

  it("responds with a valid aggregate even when system_logs is empty", async () => {
    const { db } = getDb();
    await db.delete(systemLogs);

    const res = await app.inject({
      method: "GET",
      url: "/api/settings/system-health",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(body.errors.recent)).toBe(true);
    expect(Array.isArray(body.plugins.failing)).toBe(true);
    expect(typeof body.queue.pending).toBe("number");
    expect(body.database.path).toBe(DB_PATH);
  });
});
