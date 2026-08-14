import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../../data/test-hooks");
const DB_PATH = `${DATA_DIR}/test-${randomBytes(4).toString("hex")}.db`;
const REPO_PATH = `${DATA_DIR}/repo-${randomBytes(4).toString("hex")}`;
const PLUGIN_ROOT = path.resolve(DATA_DIR, "plugins");

process.env.DB_PATH = DB_PATH;
process.env.GIT_REPO_ROOT = REPO_PATH;
process.env.PLUGIN_ROOT = PLUGIN_ROOT;
process.env.BETTER_AUTH_SECRET = "test-only-secret-do-not-use-in-real-deployment-aaaaaaaaaaaaaaaa";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_RATE_LIMIT_CUSTOM_RULES = JSON.stringify({ "/sign-up/*": false, "/sign-in/*": false });

mkdirSync(PLUGIN_ROOT, { recursive: true });

describe("plugin hooks engine (slice-30)", () => {
  beforeEach(async () => {
    // Reset the registry between tests so handlers don't leak.
    const { __resetHookRegistry } = await import("../hooks.js");
    __resetHookRegistry();
  });

  beforeAll(async () => {
    const { getDb } = await import("../db/index.js");
    getDb(); // initialise
  });

  afterAll(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("registerPluginHookHandlers loads a hooks-capable plugin and dispatches events", async () => {
    const { registerPluginHookHandlers } = await import("../services/plugin.service.js");
    const { dispatchHook, totalHookSubscriptionCount } = await import("../hooks.js");
    const { getDb } = await import("../db/index.js");
    const { plugins } = await import("../db/schema.js");

    const pluginId = `evthandler-${randomBytes(3).toString("hex")}`;
    const pluginDir = path.join(PLUGIN_ROOT, pluginId);
    mkdirSync(path.join(pluginDir, "server"), { recursive: true });
    // The plugin module must default-export a function that receives
    // the per-plugin API and registers at least one hook.
    writeFileSync(
      path.join(pluginDir, "server/index.js"),
      `export default function (api) { api.registerHook("pageLoad", () => { /* no-op */ }); }`,
    );

    try {
      await getDb().db.insert(plugins).values({
        id: pluginId,
        name: "Event Handler",
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

      expect(totalHookSubscriptionCount()).toBe(0);
      await registerPluginHookHandlers();
      expect(totalHookSubscriptionCount()).toBe(1);

      // Sanity: the actual handler fires.
      const n = await dispatchHook({
        event: "pageLoad",
        at: "2026-01-01T00:00:00.000Z",
        actorUserId: "u1",
        pageId: "p1",
        branchId: "b1",
      });
      expect(n).toBe(1);
    } finally {
      await getDb().db.delete(plugins).where(eq(plugins.id, pluginId));
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("does NOT load a plugin whose hooks capability is false", async () => {
    const { registerPluginHookHandlers } = await import("../services/plugin.service.js");
    const { totalHookSubscriptionCount } = await import("../hooks.js");
    const { getDb } = await import("../db/index.js");
    const { plugins } = await import("../db/schema.js");

    const pluginId = `nohook-${randomBytes(3).toString("hex")}`;
    const pluginDir = path.join(PLUGIN_ROOT, pluginId);
    mkdirSync(path.join(pluginDir, "server"), { recursive: true });
    writeFileSync(path.join(pluginDir, "server/index.js"), `export default function () { /* nothing */ }`);

    try {
      await getDb().db.insert(plugins).values({
        id: pluginId,
        name: "No Hook",
        version: "1.0.0",
        enabled: true,
        capabilities: {
          tiptapExtensions: false,
          slashCommands: false,
          toolbarItems: false,
          settingsPanel: false,
          embedTypes: false,
          serverRoutes: false,
          hooks: false,
        },
        nodeTypes: [],
        markTypes: [],
      });
      await registerPluginHookHandlers();
      expect(totalHookSubscriptionCount()).toBe(0);
    } finally {
      await getDb().db.delete(plugins).where(eq(plugins.id, pluginId));
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("setPluginEnabled(false) removes every subscription owned by the plugin", async () => {
    const { registerPluginHookHandlers, setPluginEnabled } = await import("../services/plugin.service.js");
    const { totalHookSubscriptionCount } = await import("../hooks.js");
    const { getDb } = await import("../db/index.js");
    const { plugins } = await import("../db/schema.js");

    const pluginId = `toggles-${randomBytes(3).toString("hex")}`;
    const pluginDir = path.join(PLUGIN_ROOT, pluginId);
    mkdirSync(path.join(pluginDir, "server"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, "server/index.js"),
      `export default function (api) {
         api.registerHook("pageLoad", () => {});
         api.registerHook("pageSave", () => {});
         api.registerHook("attributeChange", () => {});
       }`,
    );

    try {
      await getDb().db.insert(plugins).values({
        id: pluginId,
        name: "Toggles",
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
      expect(totalHookSubscriptionCount()).toBe(3);

      // Disable via the public API.
      await setPluginEnabled(pluginId, false, undefined);
      expect(totalHookSubscriptionCount()).toBe(0);

      // Re-enable — should load the module again (3 new subscriptions).
      await setPluginEnabled(pluginId, true, undefined);
      expect(totalHookSubscriptionCount()).toBe(3);
    } finally {
      try {
        await setPluginEnabled(pluginId, false, undefined);
      } catch {
        /* ignore — already removed */
      }
      await getDb().db.delete(plugins).where(eq(plugins.id, pluginId));
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("a plugin module without a default-export function is skipped without crashing", async () => {
    const { registerPluginHookHandlers } = await import("../services/plugin.service.js");
    const { totalHookSubscriptionCount } = await import("../hooks.js");
    const { getDb } = await import("../db/index.js");
    const { plugins } = await import("../db/schema.js");

    const pluginId = `badshape-${randomBytes(3).toString("hex")}`;
    const pluginDir = path.join(PLUGIN_ROOT, pluginId);
    mkdirSync(path.join(pluginDir, "server"), { recursive: true });
    // No default export at all.
    writeFileSync(path.join(pluginDir, "server/index.js"), `export const useless = 42;`);

    try {
      await getDb().db.insert(plugins).values({
        id: pluginId,
        name: "Bad Shape",
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
      await expect(registerPluginHookHandlers()).resolves.toBeUndefined();
      expect(totalHookSubscriptionCount()).toBe(0);
    } finally {
      await getDb().db.delete(plugins).where(eq(plugins.id, pluginId));
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("uninstallPlugin removes every subscription owned by the plugin", async () => {
    const { registerPluginHookHandlers, uninstallPlugin } = await import("../services/plugin.service.js");
    const { totalHookSubscriptionCount } = await import("../hooks.js");
    const { getDb } = await import("../db/index.js");
    const { plugins, users } = await import("../db/schema.js");

    const pluginId = `uninst-${randomBytes(3).toString("hex")}`;
    const actorId = `user-${randomBytes(4).toString("hex")}`;
    const pluginDir = path.join(PLUGIN_ROOT, pluginId);
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(path.join(pluginDir, "server"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, "server/index.js"),
      `export default function (api) { api.registerHook("pageLoad", () => {}); api.registerHook("pageSave", () => {}); }`,
    );

    try {
      // uninstallPlugin writes an audit log entry referencing the
      // actor, so the actor must exist in the users table.
      await getDb().db.insert(users).values({
        id: actorId,
        email: `${actorId}@test.invalid`,
        name: actorId,
        isAdmin: true,
      });
      await getDb().db.insert(plugins).values({
        id: pluginId,
        name: "Will Uninstall",
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
      expect(totalHookSubscriptionCount()).toBe(2);
      await uninstallPlugin(pluginId, actorId);
      expect(totalHookSubscriptionCount()).toBe(0);
    } finally {
      await getDb().db.delete(plugins).where(eq(plugins.id, pluginId));
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});