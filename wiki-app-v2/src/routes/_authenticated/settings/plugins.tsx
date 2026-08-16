import { useState, useEffect, useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { request } from "@/api/client";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useSettingsPanels } from "@/plugins/registry";
import type { PluginInfo } from "@/shared/pluginTypes";

export const Route = createFileRoute("/_authenticated/settings/plugins")({
  component: PluginSettingsPage,
});

function PluginSettingsPage() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  // §7.1 — plugin settings panels registered via registerSettingsPanel render
  // HERE, inside /settings/plugins, not as floating panels elsewhere.
  const settingsPanels = useSettingsPanels();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<PluginInfo[]>("/api/plugins");
      setPlugins(list);
    } catch { setError("Failed to load plugins"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(id: string, enabled: boolean) {
    try {
      const updated = await request<PluginInfo>(`/api/plugins/${id}/enabled`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      setPlugins(prev => prev.map(p => p.id === id ? updated : p));
      // Reload to pick up new registry state (client-side extensions change).
      window.location.reload();
    } catch { setError("Failed to toggle plugin"); }
  }

  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);

  async function doUninstall() {
    if (!pendingUninstall) return;
    const id = pendingUninstall;
    try {
      await request(`/api/plugins/${id}`, { method: "DELETE" });
      setPlugins(prev => prev.filter(p => p.id !== id));
      window.location.reload();
    } catch { setError("Failed to uninstall plugin"); }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadStatus("Uploading…");
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/plugins", { method: "POST", credentials: "include", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error((err as { error?: string }).error ?? "Upload failed");
      }
      await res.json();
      setUploadStatus("Installed! Reloading…");
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setUploadStatus("");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium mb-2">Installed Plugins</h2>
        <div className="mb-4">
          <label className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-border bg-surface-hover hover:bg-surface-elevated cursor-pointer transition-colors">
            Upload plugin (.zip)
            <input type="file" accept=".zip" onChange={handleUpload} className="hidden" />
          </label>
          {uploadStatus && <span className="ml-3 text-xs text-text-muted">{uploadStatus}</span>}
        </div>

        {error && <div className="mb-3 text-sm text-danger">{error}</div>}

        {loading ? (
          <div className="text-sm text-text-muted">Loading…</div>
        ) : plugins.length === 0 ? (
          <div className="text-sm text-text-muted">No plugins installed. Upload a .zip to get started.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-text-muted">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Version</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map(p => (
                <tr key={p.id} className="border-b border-border">
                  <td className="py-2 pr-4">{p.name} <span className="text-xs text-text-muted">({p.id})</span></td>
                  <td className="py-2 pr-4 text-text-muted">{p.version}</td>
                  <td className="py-2 pr-4">
                    <span className={p.enabled ? "text-success" : "text-text-muted"}>
                      {p.enabled ? "Enabled" : "Disabled"}
                    </span>
                    {p.disabledReason && (
                      <div className="mt-1 text-xs text-danger" title={p.disabledReason}>
                        {p.disabledReason}
                      </div>
                    )}
                    {!p.disabledReason && p.failureCount > 0 && p.enabled && (
                      <div className="mt-1 text-xs text-warning" title={p.lastError ?? ""}>
                        {p.failureCount} consecutive failure{p.failureCount === 1 ? "" : "s"}
                      </div>
                    )}
                  </td>
                  <td className="py-2 flex gap-2">
                    <button
                      type="button"
                      className="text-xs px-2 py-0.5 rounded border border-border hover:bg-surface-hover transition-colors"
                      onClick={() => toggle(p.id, !p.enabled)}
                    >
                      {p.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      className="text-xs px-2 py-0.5 rounded border border-border text-danger hover:bg-danger/10 transition-colors"
                      onClick={() => setPendingUninstall(p.id)}
                    >
                      Uninstall
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {settingsPanels.length > 0 && (
        <div>
          <h2 className="text-lg font-medium mb-2">Plugin settings</h2>
          <div className="space-y-4">
            {settingsPanels.map((panel) => (
              <section key={panel.id} className="rounded-md border border-border p-4">
                <h3 className="text-sm font-medium mb-2">{panel.label}</h3>
                {/* SettingsPanelDef.render receives { pluginId }, but the def
                    doesn't carry its owning plugin's id (registerSettingsPanel
                    doesn't capture it) — pass an empty string until the def
                    contract grows an owner id. Panels render HERE either way,
                    which is the §7.2 rule. */}
                {panel.render({ pluginId: "" })}
              </section>
            ))}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={pendingUninstall !== null}
        title={`Uninstall plugin "${pendingUninstall ?? ""}"?`}
        description="This removes the plugin's files permanently. Any content using the plugin's node types will be converted to paragraphs."
        confirmLabel="Uninstall"
        destructive
        onConfirm={() => void doUninstall()}
        onCancel={() => setPendingUninstall(null)}
      />
    </div>
  );
}
