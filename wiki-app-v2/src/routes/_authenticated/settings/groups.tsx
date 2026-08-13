import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ApiError, request } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export const Route = createFileRoute("/_authenticated/settings/groups")({
  component: GroupSettingsPage,
});

// Canonical capability catalogue (§3.18 / access.ts CAPABILITY_ROUTE_MAP).
// These are the capability strings the server actually checks — adding an
// arbitrary string here does nothing; the picker is intentionally a closed
// list so admins don't invent capabilities the middleware ignores.
const CAPABILITY_CATALOG: { id: string; label: string; description: string }[] = [
  {
    id: "admin.*",
    label: "admin.*",
    description: "Wildcard — grants access to every admin surface the middleware recognises.",
  },
  {
    id: "admin.users",
    label: "admin.users",
    description: "Access to the user-management admin routes (promote, suspend, demote).",
  },
  {
    id: "admin.groups",
    label: "admin.groups",
    description: "Access to group administration — create, edit capabilities, manage membership.",
  },
  {
    id: "admin.settings",
    label: "admin.settings",
    description: "Access to system-settings routes (storage paths, integration toggles, secrets).",
  },
  {
    id: "admin.git",
    label: "admin.git",
    description: "Access to the git-remote configuration routes used by the commit pipeline.",
  },
  {
    id: "admin.logs",
    label: "admin.logs",
    description: "Access to the admin audit-log read routes.",
  },
  {
    id: "create_permanent_links",
    label: "create_permanent_links",
    description: "Grants the ability to issue tokens with no expiration (brief §3.10). Distinct from admin.",
  },
];

interface GroupRow {
  id: string;
  name: string;
  capabilities: string[];
  memberCount: number;
}

interface MemberRow {
  userId: string;
  name: string;
  email: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
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

function GroupSettingsPage() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");

  const [editingCaps, setEditingCaps] = useState<Record<string, string[]>>({});
  const [savingCaps, setSavingCaps] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<GroupRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await request<GroupRow[]>("/api/groups");
      setGroups(list);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createGroup() {
    setCreating(true);
    setError("");
    try {
      await request("/api/groups", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
      setNewName("");
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setCreating(false);
    }
  }

  async function performDelete(id: string) {
    setDeleting(true);
    try {
      await request(`/api/groups/${id}`, { method: "DELETE" });
      if (openGroup === id) setOpenGroup(null);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setDeleting(false);
    }
  }

  async function openMembers(groupId: string) {
    setOpenGroup(groupId);
    try {
      const [m, u] = await Promise.all([
        request<MemberRow[]>(`/api/groups/${groupId}/members`),
        request<UserRow[]>("/api/users"),
      ]);
      setMembers(m);
      setUsers(u);
      setSelectedUserId("");
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function addMember() {
    if (!openGroup || !selectedUserId) return;
    try {
      await request(`/api/groups/${openGroup}/members`, { method: "POST", body: JSON.stringify({ userId: selectedUserId }) });
      await openMembers(openGroup);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function removeMember(userId: string) {
    if (!openGroup) return;
    try {
      await request(`/api/groups/${openGroup}/members/${userId}`, { method: "DELETE" });
      await openMembers(openGroup);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  function toggleCap(groupId: string, cap: string, on: boolean) {
    setEditingCaps((prev) => {
      const current = prev[groupId] ?? groups.find((g) => g.id === groupId)?.capabilities ?? [];
      const next = on ? [...new Set([...current, cap])] : current.filter((c) => c !== cap);
      return { ...prev, [groupId]: next };
    });
  }

  async function saveCaps(groupId: string) {
    const next = editingCaps[groupId];
    if (!next) return;
    setSavingCaps(groupId);
    try {
      const updated = await request<GroupRow>(`/api/groups/${groupId}`, {
        method: "PATCH",
        body: JSON.stringify({ capabilities: next }),
      });
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, capabilities: updated.capabilities } : g)));
      setEditingCaps((prev) => {
        const { [groupId]: _drop, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSavingCaps(null);
    }
  }

  const totalCapabilities = useMemo(
    () => new Set(groups.flatMap((g) => g.capabilities)).size,
    [groups],
  );

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-medium">Groups &amp; Permissions</h2>
        <p className="text-sm text-text-muted">
          Groups are the sole permission-granting mechanism — their capabilities define what members can do system-wide.
        </p>
      </div>

      {!loading && groups.length > 0 && (
        <dl className="flex gap-6 text-sm">
          <div>
            <dt className="text-text-muted">Groups</dt>
            <dd className="text-base font-medium">{groups.length}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Members</dt>
            <dd className="text-base font-medium">{groups.reduce((n, g) => n + g.memberCount, 0)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Distinct capabilities</dt>
            <dd className="text-base font-medium">{totalCapabilities}</dd>
          </div>
        </dl>
      )}

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      )}

      <section className="flex gap-2">
        <input
          aria-label="New group name"
          placeholder="New group name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <Button size="sm" onClick={() => void createGroup()} disabled={creating || !newName.trim()}>
          {creating ? "Creating…" : "Create group"}
        </Button>
      </section>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-text-muted">No groups yet — create one above to grant permissions.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const pendingCaps = editingCaps[g.id];
            const currentCaps = pendingCaps ?? g.capabilities;
            const dirty = pendingCaps !== undefined;
            const isSaving = savingCaps === g.id;
            return (
              <div key={g.id} className="rounded-md border border-border" data-group-row={g.id}>
                <div className="flex items-center justify-between p-4">
                  <div>
                    <h3 className="font-medium">{g.name}</h3>
                    <p className="text-xs text-text-muted">
                      {g.memberCount} member(s)
                      {g.capabilities.length > 0 && <> · {g.capabilities.length} capability(ies)</>}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => (openGroup === g.id ? setOpenGroup(null) : void openMembers(g.id))}>
                      {openGroup === g.id ? "Close" : "Members"}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirmDelete(g)}>
                      Delete
                    </Button>
                  </div>
                </div>

                <div className="border-t border-border p-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium uppercase tracking-wide text-text-muted">Capabilities</h4>
                    {dirty && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setEditingCaps((prev) => { const { [g.id]: _drop, ...rest } = prev; return rest; })}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => void saveCaps(g.id)} disabled={isSaving}>
                          {isSaving ? "Saving…" : "Save changes"}
                        </Button>
                      </div>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1.5" data-group-caps={g.id}>
                    {CAPABILITY_CATALOG.map((c) => {
                      const on = currentCaps.includes(c.id);
                      const isWildcardOn = on || currentCaps.includes("admin.*");
                      return (
                        <li key={c.id} className="flex items-start gap-3 text-sm">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => toggleCap(g.id, c.id, e.target.checked)}
                            className="mt-0.5 h-4 w-4 rounded border-border"
                            aria-label={`${c.label} capability`}
                          />
                          <div className="flex-1">
                            <p className="font-mono text-xs text-text-secondary">{c.label}</p>
                            <p className="text-xs text-text-muted">{c.description}</p>
                          </div>
                          {isWildcardOn && !on && (
                            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] uppercase text-warning" title="Granted via admin.* wildcard">via wildcard</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {openGroup === g.id && (
                  <div className="border-t border-border p-4">
                    <h4 className="text-xs font-medium uppercase tracking-wide text-text-muted">Members</h4>
                    <div className="mt-2 flex gap-2">
                      <select
                        value={selectedUserId}
                        onChange={(e) => setSelectedUserId(e.target.value)}
                        aria-label="User to add"
                        className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                      >
                        <option value="">Add a member…</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} ({u.email})
                          </option>
                        ))}
                      </select>
                      <Button size="sm" variant="outline" onClick={() => void addMember()} disabled={!selectedUserId}>
                        Add
                      </Button>
                    </div>
                    {members.length === 0 ? (
                      <p className="mt-3 text-sm text-text-muted">No members yet.</p>
                    ) : (
                      <ul className="mt-3 space-y-1">
                        {members.map((m) => (
                          <li key={m.userId} className="flex items-center justify-between text-sm">
                            <span>
                              {m.name} <span className="text-text-muted">({m.email})</span>
                            </span>
                            <button type="button" className="text-xs text-danger hover:underline" onClick={() => void removeMember(m.userId)}>
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete group?"
        description={
          confirmDelete
            ? <>Delete <strong>{confirmDelete.name}</strong>? {confirmDelete.memberCount} membership(s) and every permission grant issued through the group are removed. There is no undo.</>
            : null
        }
        confirmLabel="Delete group"
        destructive
        pending={deleting}
        onConfirm={() => { if (confirmDelete) void performDelete(confirmDelete.id); }}
        onCancel={() => { if (!deleting) setConfirmDelete(null); }}
      />
    </div>
  );
}
