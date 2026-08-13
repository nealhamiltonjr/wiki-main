import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { request } from "@/api/client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/settings/groups")({
  component: GroupSettingsPage,
});

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<GroupRow[]>("/api/groups");
      setGroups(list);
    } catch {
      setError("Failed to load groups");
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
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function deleteGroup(id: string) {
    if (!confirm("Delete this group? Membership and permission grants through it are removed.")) return;
    try {
      await request(`/api/groups/${id}`, { method: "DELETE" });
      if (openGroup === id) setOpenGroup(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
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
      setError((err as Error).message);
    }
  }

  async function addMember() {
    if (!openGroup || !selectedUserId) return;
    try {
      await request(`/api/groups/${openGroup}/members`, { method: "POST", body: JSON.stringify({ userId: selectedUserId }) });
      await openMembers(openGroup);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeMember(userId: string) {
    if (!openGroup) return;
    try {
      await request(`/api/groups/${openGroup}/members/${userId}`, { method: "DELETE" });
      await openMembers(openGroup);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-medium">Groups &amp; Permissions</h2>
        <p className="text-sm text-text-muted">
          Groups are the sole permission-granting mechanism — their capabilities define what members can do system-wide.
        </p>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

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
        <p className="text-sm text-text-muted">No groups yet.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.id} className="rounded-md border border-border">
              <div className="flex items-center justify-between p-4">
                <div>
                  <h3 className="font-medium">{g.name}</h3>
                  <p className="text-xs text-text-muted">
                    {g.memberCount} member(s)
                    {g.capabilities.length > 0 && <> · capabilities: {g.capabilities.join(", ")}</>}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => (openGroup === g.id ? setOpenGroup(null) : void openMembers(g.id))}>
                    {openGroup === g.id ? "Close members" : "Members"}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => void deleteGroup(g.id)}>
                    Delete
                  </Button>
                </div>
              </div>
              {openGroup === g.id && (
                <div className="border-t border-border p-4">
                  <div className="flex gap-2">
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
          ))}
        </div>
      )}
    </div>
  );
}
