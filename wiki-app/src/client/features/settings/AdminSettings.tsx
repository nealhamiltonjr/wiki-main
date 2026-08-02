import { useEffect, useState } from "react";
import type { AdminSettingView } from "../../api/client.js";
import { api } from "../../api/client.js";
import { SettingRow } from "./SettingRow.js";
import { GitSection } from "./GitSection.js";

interface Group { id: string; name: string }
interface Member { userId: string; email: string; name: string }
interface UserRow { id: string; email: string; name: string; isAdmin: boolean }

export function AdminSettings() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [settings, setSettings] = useState<AdminSettingView[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [g, u, s] = await Promise.all([
        api.listGroups(),
        api.listAdminUsers(),
        api.listSettings(),
      ]);
      setGroups(g);
      setUsers(u);
      setSettings(s);
      const memberLists = await Promise.all(g.map((group) => api.listGroupMembers(group.id)));
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
    await api.createGroup(newGroupName.trim());
    setNewGroupName("");
    refresh();
  }

  async function deleteGroup(id: string) {
    await api.deleteGroup(id);
    refresh();
  }

  async function addMember(groupId: string, userId: string) {
    if (!userId) return;
    await api.addGroupMember(groupId, userId);
    refresh();
  }

  async function removeMember(groupId: string, userId: string) {
    await api.removeGroupMember(groupId, userId);
    refresh();
  }

  async function saveSetting(key: string, value: unknown) {
    await api.setSetting(key, value);
    refresh();
  }

  async function deleteSetting(key: string) {
    await api.deleteSetting(key);
    refresh();
  }

  // Group settings by section, preserving registration order.
  const sections = new Map<string, AdminSettingView[]>();
  for (const s of settings) {
    const list = sections.get(s.section) ?? [];
    list.push(s);
    sections.set(s.section, list);
  }
  const sectionOrder = ["General", "Email", "Git", "Sync", "Security", "Custom"];
  const orderedSections = [...sections.entries()].sort(([a], [b]) => {
    const ia = sectionOrder.indexOf(a);
    const ib = sectionOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return (
    <div className="settings-page" style={{ padding: "24px 0", maxWidth: "none" }}>
      <h2>Admin settings</h2>
      {error && <div className="wiki-banner">{error}</div>}

      <GitSection />

      <section className="settings-card">
        <h3>Groups</h3>
        {groups.map((g) => (
          <div key={g.id} className="settings-group-box">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong>{g.name}</strong>
              <button onClick={() => deleteGroup(g.id)} className="settings-btn danger" style={{ padding: "2px 10px" }}>Delete group</button>
            </div>
            <div style={{ marginTop: 6 }}>
              {(members[g.id] ?? []).map((m) => (
                <div key={m.userId} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                  <span>{m.name} ({m.email})</span>
                  <button onClick={() => removeMember(g.id, m.userId)} className="wiki-icon-btn">Remove</button>
                </div>
              ))}
              <select
                defaultValue=""
                onChange={(e) => { addMember(g.id, e.target.value); e.target.value = ""; }}
                className="settings-select"
                style={{ marginTop: 4 }}
              >
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
          <input placeholder="New group name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} className="settings-text" style={{ marginBottom: 0 }} />
          <button onClick={createGroup} className="settings-btn primary">Create group</button>
        </div>
      </section>

      {orderedSections.map(([section, defs]) => (
        <section className="settings-card" key={section}>
          <h3>{section}</h3>
          {defs.map((s) => (
            <SettingRow
              key={s.key}
              setting={s}
              onSave={saveSetting}
              onDelete={section === "Custom" ? deleteSetting : undefined}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
