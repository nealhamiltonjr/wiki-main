/**
 * §11.3 plugin failure isolation — gate test.
 *
 * A misbehaving plugin (one whose hook handler throws on every
 * invocation) must not take down the host app. After N consecutive
 * failures the plugin is auto-disabled and its `disabledReason` is
 * populated; subsequent hook dispatches no longer reach it. A
 * successful invocation of a previously-failing plugin's handler
 * resets the counter.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../data/test-plugin-failure");
const DB_PATH = `${DATA_DIR}/test-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `${DATA_DIR}/repo-${randomBytes(4).toString("hex")}`;
const PLUGIN_ROOT = path.resolve(DATA_DIR, "plugins");

process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.PLUGIN_ROOT = PLUGIN_ROOT;
process.env.PLUGIN_FAILURE_THRESHOLD = "3"; // small for fast test
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({ "/sign-up/*": false, "/sign-in/*": false });

mkdirSync(PLUGIN_ROOT, { recursive: true });

describe("§11.3 plugin failure isolation", () => {
  beforeEach(async () => {
    const { __resetHookRegistry } = await import("../hooks.js");
    const { installPluginFailureHook } = await import("../services/plugin.service.js");
    __resetHookRegistry();
    // Re-install after the reset — the test suite wipes the failure
    // handler too, which is fine for isolation but means each test
    // has to re-wire the persistence layer.
    installPluginFailureHook();
  });

  beforeAll(async () => {
    const { getDb } = await import("../db/index.js");
    getDb();
  });

  afterAll(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  async function installBrokenPlugin(id: string, throws: boolean): Promise<void> {
    const { registerPluginHookHandlers } = await import("../services/plugin.service.js");
    const { plugins } = await import("../db/schema.js");
    const { getDb } = await import("../db/index.js");

    const pluginDir = path.join(PLUGIN_ROOT, id);
    mkdirSync(path.join(pluginDir, "server"), { recursive: true });
    const body = throws
      ? `export default function (api) { api.registerHook("pageLoad", () => { throw new Error("kaboom"); }); }`
      : `export default function (api) { api.registerHook("pageLoad", () => { /* no-op */ }); }`;
    writeFileSync(path.join(pluginDir, "server/index.js"), body);
    await getDb().db.insert(plugins).values({
      id,
      name: id,
      version: "1.0.0",
      enabled: true,
      capabilities: {
        tiptapExtensions: false,
        slashCommands: false,
        toolbarItems: false,
        settingsPanel: false,
        embedTypes: false,
        serverRoutes: false,
        hooks: true,
      },
      nodeTypes: [],
      markTypes: [],
    });
    await registerPluginHookHandlers();
  }

  async function dispatchOnce(pluginId: string): Promise<{ invoked: number; autoDisabled: boolean; failureCount: number }> {
    const { dispatchHook } = await import("../hooks.js");
    const { plugins } = await import("../db/schema.js");
    const { getDb } = await import("../db/index.js");
    const invoked = await dispatchHook({
      event: "pageLoad",
      at: new Date().toISOString(),
      actorUserId: "tester",
      pageId: "p",
      branchId: "b",
    });
    const [row] = await getDb().db.select().from(plugins).where(eq(plugins.id, pluginId));
    return {
      invoked,
      autoDisabled: row?.disabledReason != null,
      failureCount: row?.failureCount ?? 0,
    };
  }

  it("auto-disables a plugin after N consecutive handler throws", async () => {
    const id = `break-${randomBytes(3).toString("hex")}`;
    await installBrokenPlugin(id, true);

    // First 2 throws: counter climbs, plugin stays enabled.
    let r = await dispatchOnce(id);
    expect(r.invoked).toBe(1);
    expect(r.failureCount).toBe(1);
    expect(r.autoDisabled).toBe(false);

    r = await dispatchOnce(id);
    expect(r.failureCount).toBe(2);
    expect(r.autoDisabled).toBe(false);

    // Third throw trips the threshold (PLUGIN_FAILURE_THRESHOLD=3).
    r = await dispatchOnce(id);
    expect(r.failureCount).toBe(3);
    expect(r.autoDisabled).toBe(true);

    // Host app still works: dispatchHook returns 0 because the broken
    // plugin's subscription was unregistered and no other plugin is
    // listening. Critically, dispatch itself didn't throw.
    r = await dispatchOnce(id);
    expect(r.invoked).toBe(0);
    expect(r.autoDisabled).toBe(true);

    const { plugins } = await import("../db/schema.js");
    const { getDb } = await import("../db/index.js");
    const [row] = await getDb().db.select().from(plugins).where(eq(plugins.id, id));
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toMatch(/Auto-disabled after 3 consecutive handler failures/);
    expect(row?.lastError).toMatch(/kaboom/);
  });

  it("a successful handler invocation resets the counter", async () => {
    // Install a plugin whose handler can be flipped between throwing
    // and succeeding by toggling a file-based flag. Easier: install
    // two plugins — one throws once, one is healthy — and confirm
    // the healthy one clears the broken one's counter on success.
    const broken = `flap-${randomBytes(3).toString("hex")}`;
    const healthy = `ok-${randomBytes(3).toString("hex")}`;
    await installBrokenPlugin(broken, true);
    await installBrokenPlugin(healthy, false);

    const { dispatchHook } = await import("../hooks.js");
    const { plugins } = await import("../db/schema.js");
    const { getDb } = await import("../db/index.js");

    await dispatchHook({
      event: "pageLoad", at: new Date().toISOString(),
      actorUserId: "tester", pageId: "p", branchId: "b",
    });
    let [brokenRow] = await getDb().db.select().from(plugins).where(eq(plugins.id, broken));
    expect(brokenRow?.failureCount).toBe(1);

    // Dispatching again — broken still throws (now at 2),
    // healthy runs cleanly. The healthy plugin's success call
    // resets only the *healthy* plugin's counter; broken is still
    // climbing. Then we directly invoke the broken plugin's
    // handler via the registry to confirm a single success clears
    // its counter too. To make this happen without re-installing
    // we just register a new (non-throwing) handler for broken.

    const { registerHook } = await import("../hooks.js");
    registerHook(broken, "pageLoad", async () => { /* ok */ });
    await dispatchHook({
      event: "pageLoad", at: new Date().toISOString(),
      actorUserId: "tester", pageId: "p", branchId: "b",
    });

    [brokenRow] = await getDb().db.select().from(plugins).where(eq(plugins.id, broken));
    // The newly-registered handler succeeded, so counter is reset.
    expect(brokenRow?.failureCount).toBe(0);
    expect(brokenRow?.lastError).toBeNull();
  });

  it("a broken plugin does not affect a sibling healthy plugin", async () => {
    const broken = `bad-${randomBytes(3).toString("hex")}`;
    const healthy = `good-${randomBytes(3).toString("hex")}`;
    await installBrokenPlugin(broken, true);
    await installBrokenPlugin(healthy, false);

    const { dispatchHook } = await import("../hooks.js");
    const { plugins } = await import("../db/schema.js");
    const { getDb } = await import("../db/index.js");

    // Dispatch several times — well past the threshold for broken.
    for (let i = 0; i < 5; i++) {
      await dispatchHook({
        event: "pageLoad", at: new Date().toISOString(),
        actorUserId: "tester", pageId: "p", branchId: "b",
      });
    }

    const [brokenRow] = await getDb().db.select().from(plugins).where(eq(plugins.id, broken));
    const [healthyRow] = await getDb().db.select().from(plugins).where(eq(plugins.id, healthy));
    expect(brokenRow?.enabled).toBe(false);
    expect(brokenRow?.disabledReason).toMatch(/Auto-disabled/);
    expect(healthyRow?.enabled).toBe(true);
    expect(healthyRow?.failureCount).toBe(0);
  });

  it("re-enabling a plugin clears its failure state", async () => {
    const { setPluginEnabled, listPlugins } = await import("../services/plugin.service.js");
    const { plugins } = await import("../db/schema.js");
    const { getDb } = await import("../db/index.js");

    const id = `reset-${randomBytes(3).toString("hex")}`;
    await installBrokenPlugin(id, true);

    // Trip the threshold.
    for (let i = 0; i < 5; i++) {
      await dispatchOnce(id);
    }

    const [before] = await getDb().db.select().from(plugins).where(eq(plugins.id, id));
    expect(before?.enabled).toBe(false);
    expect(before?.failureCount).toBeGreaterThan(0);
    expect(before?.disabledReason).not.toBeNull();

    await setPluginEnabled(id, true, undefined);
    const [after] = await getDb().db.select().from(plugins).where(eq(plugins.id, id));
    expect(after?.enabled).toBe(true);
    expect(after?.failureCount).toBe(0);
    expect(after?.lastError).toBeNull();
    expect(after?.disabledReason).toBeNull();

    // And the public listPlugins surface carries the same info.
    const info = (await listPlugins({ disabledToo: true })).find(p => p.id === id);
    expect(info?.failureCount).toBe(0);
    expect(info?.disabledReason).toBeNull();
  });
});
