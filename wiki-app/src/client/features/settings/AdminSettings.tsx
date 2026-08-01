import { useEffect, useState } from "react";

interface Group { id: string; name: string }
interface Member { userId: string; email: string; name: string }
interface UserRow { id: string; email: string; name: string; isAdmin: boolean }
interface Setting { key: string; value: unknown; isSecret: boolean; updatedAt: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? "Request failed");
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function AdminSettings() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [settings, setSettings] = useState<Setting[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [newSettingKey, setNewSettingKey] = useState("");
  const [newSettingValue, setNewSettingValue] = useState("");
  const [newSettingSecret, setNewSettingSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [g, u, s] = await Promise.all([
        api<Group[]>("/api/groups"),
        api<UserRow[]>("/api/admin/users"),
        api<Setting[]>("/api/settings"),
      ]);
      setGroups(g);
      setUsers(u);
      setSettings(s);
      const memberLists = await Promise.all(g.map((group) => api<Member[]>(`/api/groups/${group.id}/members`)));
      setMembers(Object.fromEntries(g.map((group, i) => [group.id, memberLists[i]!])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createGroup() {
    if (!newGroupName.trim()) return;
    await api("/api/groups", { method: "POST", body: JSON.stringify({ name: newGroupName.trim() }) });
    setNewGroupName("");
    refresh();
  }

  async function deleteGroup(id: string) {
    await api(`/api/groups/${id}`, { method: "DELETE" });
    refresh();
  }

  async function addMember(groupId: string, userId: string) {
    if (!userId) return;
    await api(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId }) });
    refresh();
  }

  async function removeMember(groupId: string, userId: string) {
    await api(`/api/groups/${groupId}/members/${userId}`, { method: "DELETE" });
    refresh();
  }

  async function saveSetting() {
    if (!newSettingKey.trim()) return;
    await api(`/api/settings/${encodeURIComponent(newSettingKey.trim())}`, {
      method: "PUT",
      body: JSON.stringify({ value: newSettingValue, isSecret: newSettingSecret }),
    });
    setNewSettingKey("");
    setNewSettingValue("");
    setNewSettingSecret(false);
    refresh();
  }

  async function deleteSetting(key: string) {
    await api(`/api/settings/${encodeURIComponent(key)}`, { method: "DELETE" });
    refresh();
  }

  return (
    <div style={{ padding: 24, maxWidth: 700, fontFamily: "system-ui", fontSize: 14 }}>
      <h2>Admin settings</h2>
      {error && <div style={{ background: "#fee", padding: 8, marginBottom: 12 }}>{error}</div>}

      <section style={{ marginBottom: 32 }}>
        <h3>Groups</h3>
        {groups.map((g) => (
          <div key={g.id} style={{ border: "1px solid #ddd", borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong>{g.name}</strong>
              <button onClick={() => deleteGroup(g.id)} style={{ fontSize: 12 }}>Delete group</button>
            </div>
            <div style={{ marginTop: 6 }}>
              {(members[g.id] ?? []).map((m) => (
                <div key={m.userId} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                  <span>{m.name} ({m.email})</span>
                  <button onClick={() => removeMember(g.id, m.userId)} style={{ fontSize: 11 }}>Remove</button>
                </div>
              ))}
              <select defaultValue="" onChange={(e) => { addMember(g.id, e.target.value); e.target.value = ""; }} style={{ marginTop: 4 }}>
                <option value="" disabled>Add member…</option>
                {users
                  .filter((u) => !(members[g.id] ?? []).some((m) => m.userId === u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                  ))}
              </select>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 4 }}>
          <input placeholder="New group name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} />
          <button onClick={createGroup}>Create group</button>
        </div>
      </section>

      <section>
        <h3>System settings</h3>
        {settings.map((s) => (
          <div key={s.key} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #eee" }}>
            <span><code>{s.key}</code>{s.isSecret ? " 🔒" : ""}: {String(s.value)}</span>
            <button onClick={() => deleteSetting(s.key)} style={{ fontSize: 11 }}>Delete</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
          <input placeholder="key (e.g. email.apiKey)" value={newSettingKey} onChange={(e) => setNewSettingKey(e.target.value)} />
          <input placeholder="value" value={newSettingValue} onChange={(e) => setNewSettingValue(e.target.value)} />
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={newSettingSecret} onChange={(e) => setNewSettingSecret(e.target.checked)} /> secret
          </label>
          <button onClick={saveSetting}>Save</button>
        </div>
      </section>
    </div>
  );
}
