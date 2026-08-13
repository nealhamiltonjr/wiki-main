import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@/api/authClient";
import { ApiError, request } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export const Route = createFileRoute("/_authenticated/settings/users")({
  component: UserSettingsPage,
});

interface UserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
  suspended: boolean;
  createdAt: string;
}

function errMsg(err: unknown): string {
  if (err instanceof ApiError) {
    if (typeof err.body === "object" && err.body !== null && "error" in err.body) {
      return String((err.body as { error: unknown }).error);
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function UserSettingsPage() {
  const { data: session } = useSession();
  const me = session?.user;
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "suspend" | "unsuspend" | "demote" | "promote"; user: UserRow } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await request<UserRow[]>("/api/users");
      setUsers(list);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const adminCount = users.filter((u) => u.isAdmin && !u.suspended).length;
  const suspendedCount = users.filter((u) => u.suspended).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.isAdmin && "admin".includes(q)) ||
      (u.suspended && "suspended".includes(q))
    );
  }, [users, search]);

  async function patch(id: string, body: { isAdmin?: boolean; suspended?: boolean }) {
    setPending(id);
    try {
      const updated = await request<UserRow>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setPending(null);
    }
  }

  // The server rejects self-demotion/self-suspension, and the only-admin
  // invariant is enforced server-side too. The UI prevents the destructive
  // call before the round-trip — disabling the button keeps admins from
  // accidentally locking themselves out by demoting the last one.
  const wouldDemoteLastAdmin = (target: UserRow) => target.isAdmin && adminCount === 1;

  const open = (kind: "suspend" | "unsuspend" | "demote" | "promote", user: UserRow) => setConfirm({ kind, user });
  const close = () => setConfirm(null);

  const confirmText = (() => {
    if (!confirm) return "";
    const u = confirm.user;
    if (confirm.kind === "suspend") return `Suspend ${u.name}? They won't be able to sign in until you unsuspend them.`;
    if (confirm.kind === "unsuspend") return `Unsuspend ${u.name}? They will be able to sign in again.`;
    if (confirm.kind === "demote") return `Remove admin from ${u.name}? They keep their account but lose admin privileges.`;
    return `Make ${u.name} an admin? They will gain full access to every admin surface.`;
  })();

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-medium">Users</h2>
        <p className="text-sm text-text-muted">
          Admin user management — role changes and suspension. You cannot demote or suspend your own account.
        </p>
      </div>

      {!loading && users.length > 0 && (
        <dl className="flex gap-6 text-sm" data-user-summary>
          <div>
            <dt className="text-text-muted">Total</dt>
            <dd className="text-base font-medium">{users.length}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Admins</dt>
            <dd className="text-base font-medium">{adminCount}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Suspended</dt>
            <dd className="text-base font-medium">{suspendedCount}</dd>
          </div>
        </dl>
      )}

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      )}

      {!loading && users.length > 0 && (
        <div className="flex items-center gap-2">
          <input
            aria-label="Search users"
            placeholder="Search by name, email, or role"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-64 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {search && (
            <span className="text-xs text-text-muted">
              {filtered.length} of {users.length}
            </span>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-text-muted">No users yet.</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-text-muted">No users match “{search}”.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Email</th>
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const isSelf = u.id === me?.id;
              const isBusy = pending === u.id;
              const isLastAdmin = wouldDemoteLastAdmin(u);
              return (
                <tr key={u.id} className="border-b border-border" data-user-row={u.id}>
                  <td className="py-2 pr-4">
                    {u.name}
                    {isSelf && <span className="ml-1 text-xs text-text-muted">(you)</span>}
                  </td>
                  <td className="py-2 pr-4 text-text-muted">
                    {u.email}
                    {u.emailVerified ? null : <span className="ml-1 text-xs text-warning">unverified</span>}
                  </td>
                  <td className="py-2 pr-4">{u.isAdmin ? <Badge>Admin</Badge> : <span className="text-text-secondary">Member</span>}</td>
                  <td className="py-2 pr-4">
                    {u.suspended ? <span className="text-danger">Suspended</span> : <span className="text-success">Active</span>}
                  </td>
                  <td className="py-2">
                    {!isSelf && (
                      <div className="flex gap-3">
                        <button
                          type="button"
                          className="text-xs text-text-secondary hover:underline disabled:text-text-muted disabled:no-underline disabled:cursor-not-allowed"
                          onClick={() => u.isAdmin ? open("demote", u) : open("promote", u)}
                          disabled={isBusy || (u.isAdmin && isLastAdmin)}
                          title={u.isAdmin && isLastAdmin ? "The only remaining admin — promote someone else first" : undefined}
                          data-role-toggle
                        >
                          {u.isAdmin ? "Remove admin" : "Make admin"}
                        </button>
                        <button
                          type="button"
                          className="text-xs text-danger hover:underline disabled:text-text-muted disabled:no-underline disabled:cursor-not-allowed"
                          onClick={() => u.suspended ? open("unsuspend", u) : open("suspend", u)}
                          disabled={isBusy}
                          data-suspend-toggle
                        >
                          {u.suspended ? "Unsuspend" : "Suspend"}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "suspend" ? "Suspend account" : confirm?.kind === "unsuspend" ? "Unsuspend account" : confirm?.kind === "demote" ? "Remove admin role" : "Grant admin role"}
        description={confirmText.includes("?") ? confirmText.split("?").slice(1).join("?").trim() : confirmText}
        confirmLabel={confirm?.kind === "suspend" ? "Suspend" : confirm?.kind === "demote" ? "Remove admin" : confirm?.kind === "unsuspend" ? "Unsuspend" : "Make admin"}
        destructive={confirm?.kind === "suspend" || confirm?.kind === "demote"}
        pending={pending === confirm?.user.id}
        onConfirm={() => {
          if (!confirm) return;
          const next = confirm;
          close();
          const body =
            next.kind === "suspend" ? { suspended: true } :
            next.kind === "unsuspend" ? { suspended: false } :
            next.kind === "demote" ? { isAdmin: false } :
            { isAdmin: true };
          void patch(next.user.id, body);
        }}
        onCancel={close}
      />
    </div>
  );
}
