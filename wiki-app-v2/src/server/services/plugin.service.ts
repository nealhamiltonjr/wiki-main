import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { unzipSync, strFromU8 } from "fflate";
import type { FastifyInstance } from "fastify";

import { getDb } from "../db/index.js";
import { plugins, auditLog } from "../db/schema.js";
import type { PluginInfo, PluginCapabilities } from "../../shared/pluginTypes.js";
import { registerHook, unregisterPluginHooks, setPluginFailureHandler } from "../hooks.js";
import type { HookEventName, HookHandler } from "../hookTypes.js";

// ---------------------------------------------------------------------------
// Plugin root — mirrors file.service.ts's 3-hop resolution.
// ---------------------------------------------------------------------------
const projectRoot = (() => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return path.resolve(here, "../../..");
})();

export const PLUGIN_ROOT = process.env.PLUGIN_ROOT
  ? path.resolve(projectRoot, process.env.PLUGIN_ROOT)
  : path.resolve(projectRoot, "data/plugins");

// ---------------------------------------------------------------------------
// Manifest schema (§4.3) — Zod `.strict()`: a field the schema doesn't
// recognise is a hard reject, not a silent ignore.
// ---------------------------------------------------------------------------

const capabilitySchema = z.object({
  tiptapExtensions: z.boolean().default(false),
  slashCommands: z.boolean().default(false),
  toolbarItems: z.boolean().default(false),
  settingsPanel: z.boolean().default(false),
  embedTypes: z.boolean().default(false),
  serverRoutes: z.boolean().default(false),
  hooks: z.boolean().default(false),
});

const contentModelSchema = z.object({
  nodes: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/, "node type name must be a simple identifier")).default([]),
  marks: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/, "mark type name must be a simple identifier")).default([]),
});

const pluginManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,63}$/, "plugin id must be a filesystem-safe slug (a-z0-9, hyphens, underscores)"),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(32),
  capabilities: capabilitySchema,
  contentModel: contentModelSchema.optional(),
});

type ValidatedManifest = z.infer<typeof pluginManifestSchema>;

// Core node/mark types that a plugin content model MUST NOT collide with — the
// server's validateContent would have no way to distinguish the two.
const CORE_NODE_TYPES = new Set([
  "doc", "paragraph", "heading", "bulletList", "orderedList", "listItem",
  "blockquote", "codeBlock", "horizontalRule", "image", "table",
  "tableRow", "tableCell", "taskList", "taskItem", "details",
  "detailsContent", "detailsSummary", "mermaidDiagram", "text", "hardBreak", "mention",
]);
const CORE_MARK_TYPES = new Set([
  "bold", "italic", "underline", "strike", "code", "link",
]);

// 10 MB cap on total uncompressed plugin file size — a zip bomb of a few KB
// should never write gigabytes to disk.
const MAX_TOTAL_UNCOMPRESSED = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function isSafeRelativePath(p: string): boolean {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  const normalized = p.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(s => s.length > 0 && s !== ".");
  return !segments.some(s => s === "..");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPluginDir(pluginId: string): string {
  return path.resolve(PLUGIN_ROOT, pluginId);
}

export async function listPlugins(opts: { disabledToo?: boolean }): Promise<PluginInfo[]> {
  const { db } = getDb();
  const rows = opts.disabledToo
    ? await db.select().from(plugins)
    : await db.select().from(plugins).where(eq(plugins.enabled, true));
  return rows.map(toPluginInfo);
}

function toPluginInfo(row: typeof plugins.$inferSelect): PluginInfo {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    enabled: row.enabled,
    capabilities: row.capabilities,
    nodeTypes: row.nodeTypes,
    markTypes: row.markTypes,
    installedAt: new Date(row.installedAt).toISOString(),
    failureCount: row.failureCount,
    lastError: row.lastError,
    lastFailureAt: row.lastFailureAt ? new Date(row.lastFailureAt).toISOString() : null,
    disabledReason: row.disabledReason,
  };
}

export async function getEnabledPlugins(): Promise<PluginInfo[]> {
  return listPlugins({ disabledToo: false });
}

/**
 * Returns the union of all enabled plugins' declared content-model node types
 * so validateContent can accept them. Called on every read/save so the set MUST
 * be live (not cached at boot) — without this an enabled plugin's nodes would
 * be rejected by savePageOCC.
 */
export function getEnabledPluginNodeTypes(): Set<string> {
  try {
    const { db } = getDb();
    const rows = db.select({ nodeTypes: plugins.nodeTypes }).from(plugins).where(eq(plugins.enabled, true)).all();
    const s = new Set<string>();
    for (const r of rows) for (const t of r.nodeTypes) s.add(t);
    return s;
  } catch {
    return new Set();
  }
}

export function getEnabledPluginMarkTypes(): Set<string> {
  try {
    const { db } = getDb();
    const rows = db.select({ markTypes: plugins.markTypes }).from(plugins).where(eq(plugins.enabled, true)).all();
    const s = new Set<string>();
    for (const r of rows) for (const t of r.markTypes) s.add(t);
    return s;
  } catch {
    return new Set();
  }
}

export async function installPluginFromZip(zipBuffer: Buffer, actorUserId: string): Promise<PluginInfo> {
  const { db } = getDb();

  // 1. Unzip
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength));
  } catch {
    throw Object.assign(new Error("Invalid zip file — could not decompress"), { statusCode: 400 });
  }

  // 2. Validate every entry path
  let totalSize = 0;
  for (const [entryPath, data] of Object.entries(entries)) {
    if (!isSafeRelativePath(entryPath)) {
      throw Object.assign(new Error(`Unsafe path in zip: "${entryPath}"`), { statusCode: 400 });
    }
    totalSize += data.byteLength;
  }
  if (totalSize > MAX_TOTAL_UNCOMPRESSED) {
    throw Object.assign(new Error(`Plugin exceeds ${MAX_TOTAL_UNCOMPRESSED / 1024 / 1024}MB limit`), { statusCode: 400 });
  }

  // 3. Read and validate plugin.json
  const rawManifest = entries["plugin.json"];
  if (!rawManifest) throw Object.assign(new Error("Missing plugin.json in zip"), { statusCode: 400 });

  let manifest: ValidatedManifest;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const parsed = JSON.parse(strFromU8(rawManifest, true));
    manifest = pluginManifestSchema.parse(parsed);
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? `Invalid manifest: ${err.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      : `Invalid plugin.json: ${(err as Error).message}`;
    throw Object.assign(new Error(msg), { statusCode: 400 });
  }

  // 4. Check id uniqueness
  const [existing] = await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.id, manifest.id));
  if (existing) throw Object.assign(new Error(`Plugin "${manifest.id}" is already installed`), { statusCode: 409 });

  // 5. Check content model doesn't collide with core types
  const contentModel = manifest.contentModel ?? { nodes: [], marks: [] };
  for (const t of contentModel.nodes) {
    if (CORE_NODE_TYPES.has(t)) throw Object.assign(new Error(`Plugin node type "${t}" collides with a core node type`), { statusCode: 400 });
  }
  for (const t of contentModel.marks) {
    if (CORE_MARK_TYPES.has(t)) throw Object.assign(new Error(`Plugin mark type "${t}" collides with a core mark type`), { statusCode: 400 });
  }

  // 6. Verify required files exist per declared capabilities
  const hasClient = Object.prototype.hasOwnProperty.call(entries, "client/index.js");
  const hasServer = Object.prototype.hasOwnProperty.call(entries, "server/index.js");
  const needsClient = manifest.capabilities.tiptapExtensions || manifest.capabilities.slashCommands ||
    manifest.capabilities.toolbarItems || manifest.capabilities.settingsPanel || manifest.capabilities.embedTypes;
  if (needsClient && !hasClient) {
    throw Object.assign(new Error("Manifest declares client capabilities but no client/index.js found in zip"), { statusCode: 400 });
  }
  if (manifest.capabilities.serverRoutes && !hasServer) {
    throw Object.assign(new Error("Manifest declares serverRoutes but no server/index.js found in zip"), { statusCode: 400 });
  }
  if (manifest.capabilities.hooks && !hasServer) {
    throw Object.assign(new Error("Manifest declares hooks but no server/index.js found in zip"), { statusCode: 400 });
  }

  // 7. Extract to a temp dir, validate, then rename into place (atomic-ish)
  const destDir = getPluginDir(manifest.id);
  const tmpDir = path.resolve(PLUGIN_ROOT, `.tmp-${randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    for (const [entryPath, data] of Object.entries(entries)) {
      const fullPath = path.resolve(tmpDir, entryPath.split("/").join(path.sep));
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, data);
    }
    // Rename into final place (atomic on most filesystems)
    await rm(destDir, { recursive: true, force: true });
    await mkdir(path.dirname(destDir), { recursive: true });
    // rename can fail across devices; use copy+remove fallback:
    try {
      // node:fs/promises
      const { rename } = await import("node:fs/promises");
      await rename(tmpDir, destDir);
    } catch {
      // cross-device fallback: manual copy
      const { cp, rm } = await import("node:fs/promises");
      await cp(tmpDir, destDir, { recursive: true });
      await rm(tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true });
    throw e;
  }

  // 8. Write DB row
  await db.insert(plugins).values({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    enabled: false,
    capabilities: manifest.capabilities,
    nodeTypes: contentModel.nodes,
    markTypes: contentModel.marks,
  });

  // 9. Audit
  await db.insert(auditLog).values({
    actorUserId,
    action: "plugin_install",
    targetType: "plugin",
    targetId: manifest.id,
    meta: { version: manifest.version },
  });

  const [row] = await db.select().from(plugins).where(eq(plugins.id, manifest.id));
  if (!row) throw new Error("Plugin row missing after insert");
  return toPluginInfo(row);
}

export async function setPluginEnabled(pluginId: string, enabled: boolean, actorUserId: string | undefined): Promise<PluginInfo> {
  const { db } = getDb();
  const [existing] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
  if (!existing) throw Object.assign(new Error("Plugin not found"), { statusCode: 404 });

  // §11.3 plugin failure isolation: re-enabling a plugin clears its
  // failure counter, last error, and disabled reason so it gets a
  // clean slate. Disabling leaves them populated (so the admin UI
  // can still show *why* it was disabled).
  await db.update(plugins).set({
    enabled,
    ...(enabled
      ? { failureCount: 0, lastError: null, lastFailureAt: null, disabledReason: null }
      : {}),
  }).where(eq(plugins.id, pluginId));

  await db.insert(auditLog).values({
    actorUserId: actorUserId ?? null,
    action: enabled ? "plugin_enable" : "plugin_disable",
    targetType: "plugin",
    targetId: pluginId,
  });

  // Hooks are NOT covered by the boot-time enabled-guard: a disable
  // toggles immediately by removing every subscription this plugin
  // owns. Re-enabling loads the module again on demand so a fresh
  // boot isn't required (unlike serverRoutes, which Fastify locks at
  // boot — that's why boot already registered every serverRoutes
  // plugin; hooks don't share that constraint).
  if (enabled) {
    await loadPluginHookModule(pluginId);
  } else {
    unregisterPluginHooks(pluginId);
    _registeredHookPlugins.delete(pluginId);
  }

  // No route registration here: Fastify cannot add routes after boot, so every
  // installed serverRoutes plugin is registered at boot behind a per-request
  // enabled-guard (registerPluginServerRoutes). Flipping `enabled` is what makes
  // the guard pass or fail — no restart needed for enable/disable.
  const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
  return toPluginInfo(row!);
}

export async function uninstallPlugin(pluginId: string, actorUserId: string): Promise<void> {
  const { db } = getDb();
  const [existing] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
  if (!existing) throw Object.assign(new Error("Plugin not found"), { statusCode: 404 });

  await db.delete(plugins).where(eq(plugins.id, pluginId));
  await rm(getPluginDir(pluginId), { recursive: true, force: true });
  unregisterPluginHooks(pluginId);
  _registeredHookPlugins.delete(pluginId);

  await db.insert(auditLog).values({
    actorUserId,
    action: "plugin_uninstall",
    targetType: "plugin",
    targetId: pluginId,
  });
}

/**
 * Loads and registers server-side routes for every INSTALLED plugin that
 * declares serverRoutes — enabled or disabled — each behind a per-request
 * guard that 404s while the plugin row is missing or disabled. Called once
 * during boot (after fastify is built).
 *
 * Registration is boot-only by necessity: Fastify refuses to add routes after
 * `ready()`, so a plugin whose zip is uploaded while the instance is running
 * cannot get server routes until the next restart (its client capabilities
 * still come live immediately). Loading a disabled plugin's module at boot is
 * safe — the guard never lets a request through — and it means enable/disable
 * toggles take effect instantly on already-registered routes. The guard also
 * makes uninstall effective: the row disappears → 404.
 *
 * A misbehaving plugin (bad module, route without config.access — the §4.5
 * fail-closed boot check) is caught and logged; it never crashes the instance.
 */
export async function registerPluginServerRoutes(app: FastifyInstance): Promise<void> {
  const installed = await listPlugins({ disabledToo: true });
  for (const plugin of installed) {
    if (plugin.capabilities.serverRoutes) await registerPluginServerRoutesIfNeeded(app, plugin);
  }
}

/**
 * Brief §13.5: load every enabled plugin that declared `hooks`
 * capability and give it a chance to subscribe via registerHook.
 * Unlike server routes, hooks can be re-registered at runtime:
 * install / enable / disable / uninstall all just call this and
 * its sibling `unregisterPluginHooks`. The plugin server module
 * shape is identical to the serverRoutes case — default-export
 * a Fastify plugin function that calls `registerHook`.
 */
export async function registerPluginHookHandlers(): Promise<void> {
  const installed = await listPlugins({ disabledToo: true });
  for (const plugin of installed) {
    if (plugin.capabilities.hooks && plugin.enabled) {
      await loadPluginHookModule(plugin.id);
    }
  }
}

/**
 * Same dynamic import + try/catch contract as
 * `registerPluginServerRoutesIfNeeded`, but with a thinner shape:
 * the module's default export is called with the per-plugin hook
 * API (a closure over registerHook). No Fastify register call.
 */
async function loadPluginHookModule(pluginId: string): Promise<void> {
  if (_registeredHookPlugins.has(pluginId)) return;
  try {
    const mod: {
      default?: (api: { registerHook: (event: HookEventName, handler: HookHandler) => void }) => void;
    } = await import(/* @vite-ignore */`${getPluginDir(pluginId)}/server/index.js`);
    if (!mod || typeof mod.default !== "function") {
      // eslint-disable-next-line no-console
      console.warn(`[hooks] plugin "${pluginId}" server module does not default-export a function; skipping hook registration`);
      return;
    }
    // Build a tiny per-plugin API surface. The plugin can ONLY
    // call registerHook through this — no access to the global
    // registry or any other capability.
    const api = {
      registerHook(event: HookEventName, handler: HookHandler) {
        registerHook(pluginId, event, handler);
      },
    };
    mod.default(api);
    _registeredHookPlugins.add(pluginId);
    // eslint-disable-next-line no-console
    console.log(`[hooks] Loaded hook handlers for plugin "${pluginId}"`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[hooks] Failed to load hook handlers for plugin "${pluginId}":`, err);
  }
}

/**
 * Register a single plugin's server module under /api/plugins/<id> behind the
 * enabled-guard. Idempotent per plugin id per process.
 */
async function registerPluginServerRoutesIfNeeded(app: FastifyInstance, plugin: { id: string; capabilities: PluginCapabilities }): Promise<void> {
  if (_registeredServerPlugins.has(plugin.id)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod: { default: Parameters<FastifyInstance["register"]>[0] } = await import(
      /* @vite-ignore */`${getPluginDir(plugin.id)}/server/index.js`
    );
    if (!mod || typeof mod.default !== "function") {
      // eslint-disable-next-line no-console
      console.warn(`[plugins] "${plugin.id}" server/index.js must default-export a Fastify plugin function`);
      return;
    }
    // Register in a child scope with an onRequest guard: the routes only answer
    // while the plugin row exists AND is enabled.
    // §11.3 plugin failure isolation: a thrown server-route handler from the
    // plugin feeds the same per-plugin failure counter as a hook throw, and
    // the success path of a clean 2xx response clears it (via setResponseError
    // / onSend hooks we set up below).
    await app.register(async (child) => {
      child.addHook("onRequest", async (_request, reply) => {
        const { db } = getDb();
        const [row] = await db
          .select({ enabled: plugins.enabled })
          .from(plugins)
          .where(eq(plugins.id, plugin.id));
        if (!row || !row.enabled) return reply.code(404).send({ error: "Plugin not found" });
      });
      child.addHook("onError", async (_request, _reply, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        await recordPluginFailure(plugin.id, `server route error: ${msg}`, err);
      });
      child.addHook("onSend", async (_request, reply, _payload) => {
        // 2xx = success; non-2xx (4xx/5xx) treated as a failure for counter
        // purposes so a plugin that always 500s gets auto-disabled even when
        // its handlers don't actually throw.
        const code = reply.statusCode;
        if (code >= 200 && code < 400) {
          await clearPluginFailure(plugin.id);
        } else if (code >= 500) {
          await recordPluginFailure(plugin.id, `server route returned ${code}`, null);
        }
      });
      await child.register(mod.default, { prefix: `/api/plugins/${plugin.id}` });
    });
    _registeredServerPlugins.add(plugin.id);
    // eslint-disable-next-line no-console
    console.log(`[plugins] Loaded server routes for "${plugin.id}"`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[plugins] Failed to load server routes for "${plugin.id}":`, err);
  }
}

/** Plugin server modules this process has already registered (see above). */
const _registeredServerPlugins = new Set<string>();

/** Plugin hook modules this process has already loaded. Brief §13.5. */
const _registeredHookPlugins = new Set<string>();

// ---------------------------------------------------------------------------
// §11.3 plugin failure isolation
// ---------------------------------------------------------------------------

/**
 * Consecutive-failure threshold before a plugin is auto-disabled.
 * Matches PLUGIN_FAILURE_THRESHOLD used by hooks.ts (read the same
 * env var directly here so they can't drift).
 */
function pluginFailureThreshold(): number {
  const raw = process.env.PLUGIN_FAILURE_THRESHOLD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/**
 * Cap stored error messages so a misbehaving plugin can't bloat the
 * row. 500 chars is plenty for a stack-trace top frame and a few
 * lines of message; anything beyond it gets an ellipsis.
 */
function clampErrorMessage(msg: string): string {
  if (msg.length <= 500) return msg;
  return msg.slice(0, 497) + "...";
}

/**
 * Increment a plugin's consecutive-failure counter, persist the
 * last-error snapshot, and auto-disable it (clearing the
 * per-process hook subscriptions via the registered failure
 * handler return value) if the threshold is exceeded. Returns the
 * new count and whether the plugin was just auto-disabled by this
 * call.
 *
 * Public so the server-route guard in registerPluginServerRoutes
 * can use the same persistence path for plugin-owned server
 * endpoints.
 */
export async function recordPluginFailure(
  pluginId: string,
  message: string,
  _error: unknown,
): Promise<{ failureCount: number; autoDisabled: boolean }> {
  const { db } = getDb();
  const threshold = pluginFailureThreshold();
  const now = new Date();
  const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
  if (!row) return { failureCount: 0, autoDisabled: false };
  const newCount = (row.failureCount ?? 0) + 1;
  const willDisable = newCount >= threshold;
  await db.update(plugins).set({
    failureCount: newCount,
    lastError: clampErrorMessage(message),
    lastFailureAt: now,
    // Stamp the disabled reason the moment the threshold is
    // crossed. The next failure (if any) won't overwrite it.
    ...(willDisable
      ? {
          enabled: false,
          disabledReason: `Auto-disabled after ${newCount} consecutive handler failures. Last error: ${clampErrorMessage(message)}`,
        }
      : {}),
  }).where(eq(plugins.id, pluginId));
  if (willDisable) {
    // Audit the auto-disable; admin UI surfaces this as the
    // disabledReason too.
    await db.insert(auditLog).values({
      actorUserId: null,
      action: "plugin_auto_disabled",
      targetType: "plugin",
      targetId: pluginId,
      meta: { failureCount: newCount, lastError: clampErrorMessage(message) },
    });
    unregisterPluginHooks(pluginId);
    _registeredHookPlugins.delete(pluginId);
  }
  return { failureCount: newCount, autoDisabled: willDisable };
}

/**
 * Reset a plugin's failure counter and clear its last-error
 * snapshot. Called automatically on each successful hook handler
 * invocation so a transient blip doesn't escalate. (Re-enabling a
 * plugin also resets; see setPluginEnabled.)
 */
export async function clearPluginFailure(pluginId: string): Promise<void> {
  const { db } = getDb();
  await db.update(plugins).set({
    failureCount: 0,
    lastError: null,
    lastFailureAt: null,
  }).where(eq(plugins.id, pluginId));
}

/**
 * Boot-time wire: connect the hooks registry to the persistence
 * layer. Called once from server/index.ts before any plugin
 * module is loaded.
 */
export function installPluginFailureHook(): void {
  setPluginFailureHandler(async ({ kind, pluginId, message }) => {
    if (kind === "success") {
      await clearPluginFailure(pluginId);
      return { failureCount: 0, autoDisabled: false };
    }
    return recordPluginFailure(pluginId, message, null);
  });
}
