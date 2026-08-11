import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listPlugins, installPluginFromZip, setPluginEnabled, uninstallPlugin, getPluginDir } from "../services/plugin.service.js";

export async function pluginRoutes(app: FastifyInstance) {
  // List installed plugins. Non-admins see only enabled ones (the client needs
  // this at startup for dynamic bundle loading); admins see all.
  app.get("/api/plugins", { config: { access: "authenticated" } }, async (request) => {
    const user = (request as any).userContext as { isAdmin: boolean };
    return listPlugins({ disabledToo: user.isAdmin });
  });

  // Upload + install a plugin zip. Admin-only: uploading untrusted code is an
  // operator/instance-owner action. (§4.5 trust boundary)
  app.post("/api/plugins", { config: { access: "admin" } }, async (request, reply) => {
    const user = (request as any).userContext as { id: string };

    const mp = await request.file();
    if (!mp) return reply.code(400).send({ error: "No zip file provided" });
    if (!mp.filename.endsWith(".zip") && mp.mimetype !== "application/zip") {
      return reply.code(400).send({ error: "Only .zip files are accepted" });
    }

    const zipBuffer = await mp.toBuffer();
    const info = await installPluginFromZip(zipBuffer, user.id);
    return reply.code(201).send(info);
  });

  // Enable/disable toggle. Admin-only.
  app.put("/api/plugins/:id/enabled", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { enabled } = request.body as { enabled: boolean };
    const user = (request as any).userContext as { id: string };
    const info = await setPluginEnabled(id, enabled, user.id);
    return reply.send(info);
  });

  // Uninstall.
  app.delete("/api/plugins/:id", { config: { access: "admin" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).userContext as { id: string };
    await uninstallPlugin(id, user.id);
    return reply.code(204).send();
  });

  // Serve a plugin's client bundle for the browser's dynamic import().
  // The path is deliberately: /plugins/<id>/client/index.js — only this exact
  // sub-path is served; general static serving of plugin assets is NOT enabled
  // (SVGs/HTML served as-is would be in the page origin, same as inline SVG's
  // script problem). The id is validated against the DB so a bogus id can't
  // traverse the filesystem.
  app.get("/plugins/:id/client/index.js", { config: { access: "public" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // Validate the id exists in the DB — a non-existent id means we won't serve
    // files from random dirs under data/plugins.
    const all = await listPlugins({ disabledToo: true });
    if (!all.some(p => p.id === id)) return reply.code(404).send({ error: "Plugin not found" });

    const filePath = path.resolve(getPluginDir(id), "client/index.js");
    // Defense-in-depth: the resolved path MUST stay inside the plugin dir.
    if (!filePath.startsWith(getPluginDir(id) + path.sep)) {
      return reply.code(404).send({ error: "Not found" });
    }

    try {
      const content = await readFile(filePath, "utf-8");
      reply.header("Content-Type", "application/javascript; charset=utf-8");
      reply.header("X-Content-Type-Options", "nosniff");
      // Cache for 5 minutes — plugin bundles don't change without a reinstall.
      reply.header("Cache-Control", "public, max-age=300");
      return reply.send(content);
    } catch {
      return reply.code(404).send({ error: "Bundle not found" });
    }
  });
}
