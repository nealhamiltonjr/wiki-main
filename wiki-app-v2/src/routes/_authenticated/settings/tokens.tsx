import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@/api/authClient";
import { ApiError, request } from "@/api/client";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/settings/tokens")({
  component: TokenSettingsPage,
});

interface ApiTokenRow {
  id: string;
  type: string;
  name: string | null;
  scopeType: string;
  permission: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function errMsg(err: unknown): string {
  if (err instanceof ApiError && typeof err.body === "object" && err.body !== null && "error" in err.body) {
    return String((err.body as { error: unknown }).error);
  }
  return err instanceof Error ? err.message : String(err);
}

function TokenSettingsPage() {
  const { data: session } = useSession();
  const isAdmin = !!session?.user?.isAdmin;

  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [permission, setPermission] = useState<"view" | "edit" | "admin">("view");
  // §3.10 — expiration-less tokens are permissioned. Non-admins must pick an
  // expiration date (the server enforces this too; the UI just preempts it).
  const [expiresAt, setExpiresAt] = useState(isAdmin ? "" : today());
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<{ token: string; name: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<ApiTokenRow[]>("/api/tokens");
      setTokens(list);
    } catch {
      setError("Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    setCreating(true);
    setError("");
    try {
      const res = await request<{ id: string; token: string; name: string | null }>("/api/tokens", {
        method: "POST",
        body: JSON.stringify({
          name,
          scopeType: "account",
          permission,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      setNewToken(res);
      setName("");
      setExpiresAt("");
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setCreating(false);
    }
  }

  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);

  async function doRevoke() {
    if (!pendingRevoke) return;
    try {
      const id = pendingRevoke;
      await request(`/api/tokens/${id}`, { method: "DELETE" });
      setTokens((prev) => prev.map((t) => (t.id === id ? { ...t, revokedAt: new Date().toISOString() } : t)));
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-medium">Tokens</h2>
        <p className="text-sm text-text-muted">
          API tokens let scripts authenticate as you. The raw value is shown only once at creation.
        </p>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

      {newToken && (
        <div className="rounded-md border border-success/40 bg-surface p-4 text-sm">
          <p className="font-medium">Token created — copy it now, it won&apos;t be shown again:</p>
          <code className="mt-2 block break-all rounded bg-code-bg px-2 py-1.5 font-mono text-xs text-code-text">{newToken.token}</code>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setNewToken(null)}>
            Done
          </Button>
        </div>
      )}

      {showCreate && (
        <section className="space-y-3 rounded-md border border-border p-4">
          <h3 className="text-sm font-medium">New API token</h3>
          <input
            aria-label="Token name"
            placeholder="e.g. CI deploy script"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <div className="flex items-center gap-4">
            <label className="text-sm text-text-muted">
              Permission{" "}
              <select
                value={permission}
                onChange={(e) => setPermission(e.target.value as typeof permission)}
                className="ml-2 h-8 rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="view">view</option>
                <option value="edit">edit</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label className="text-sm text-text-muted">
              Expires{" "}
              <input
                aria-label="Expiration date"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="ml-2 h-8 rounded-md border border-border bg-background px-2 text-sm"
              />
              {isAdmin ? (
                <span className="ml-1 text-xs">(blank = never)</span>
              ) : (
                <span className="ml-1 text-xs">(required — permanent tokens need admin)</span>
              )}
            </label>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void create()} disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create token"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      {!showCreate && !newToken && (
        <Button size="sm" onClick={() => setShowCreate(true)}>
          New API token
        </Button>
      )}

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-text-muted">No tokens yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Scope</th>
              <th className="py-2 pr-4 font-medium">Permission</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} className="border-b border-border">
                <td className="py-2 pr-4">{t.name ?? "(unnamed)"}</td>
                <td className="py-2 pr-4 text-text-muted">{t.scopeType}</td>
                <td className="py-2 pr-4 text-text-muted">{t.permission}</td>
                <td className="py-2 pr-4">
                  {t.revokedAt ? (
                    <span className="text-text-muted">Revoked</span>
                  ) : t.expiresAt && new Date(t.expiresAt).getTime() < Date.now() ? (
                    <span className="text-text-muted">Expired</span>
                  ) : (
                    <span className="text-success">Active</span>
                  )}
                </td>
                <td className="py-2">
                  {!t.revokedAt && (
                    <button type="button" className="text-xs text-danger hover:underline" onClick={() => setPendingRevoke(t.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ConfirmDialog
        open={pendingRevoke !== null}
        title="Revoke this token?"
        description="Anything using this token will stop working immediately. This cannot be undone."
        confirmLabel="Revoke"
        destructive
        onConfirm={() => void doRevoke()}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}
