import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../../api/client.js";

interface Share {
  id: string;
  name: string | null;
  permission: "view" | "edit";
  expiresAt: string | null;
  passwordProtected: boolean;
}

export function ShareDialog({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setShares(await api.listShares(branchId));
    } catch {
      setShares([]);
    }
  }

  useEffect(() => { void load(); }, [branchId]);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const res = await api.createShare(branchId, {
        permission,
        password: password || undefined,
        name: name || undefined,
      });
      setFreshToken(res.shareUrl);
      setPassword("");
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create share link");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api.revokeShare(id);
    await load();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Share page">
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-medium">Share this page</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-text-muted hover:bg-surface-hover">
            <X className="h-4 w-4" />
          </button>
        </div>

        {freshToken && (
          <div className="space-y-1 rounded border border-border p-3 text-sm">
            <div className="text-text-secondary">Share URL (copy it now — shown once)</div>
            <input readOnly value={freshToken} onFocus={(e) => e.currentTarget.select()} className="w-full rounded border bg-surface p-1 font-mono text-xs" />
          </div>
        )}

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="w-20 text-text-muted">Permission</span>
            <select value={permission} onChange={(e) => setPermission(e.target.value as "view" | "edit")} className="rounded border bg-background px-2 py-1 text-sm">
              <option value="view">View</option>
              <option value="edit">Edit</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="w-20 text-text-muted">Password</span>
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="optional" className="rounded border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="w-20 text-text-muted">Label</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" className="rounded border bg-background px-2 py-1 text-sm" />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="button" onClick={create} disabled={busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-primary disabled:opacity-50">
            {busy ? "Creating…" : "Create share link"}
          </button>
        </div>

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-text-muted">Existing links</div>
          {shares.length === 0 ? (
            <p className="text-xs text-text-muted">No share links yet.</p>
          ) : (
            <ul className="space-y-1">
              {shares.map((s) => (
                <li key={s.id} className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">
                    {s.name ?? "Untitled"} · {s.permission}
                    {s.passwordProtected ? " · 🔒" : ""}
                  </span>
                  <button type="button" onClick={() => revoke(s.id)} className="text-danger underline">Revoke</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
