import { useEffect, useState, useRef } from "react";
import type { AdminSettingView } from "../../api/client.js";
import { api } from "../../api/client.js";
import { SettingRow } from "./SettingRow.js";
import { GitSection } from "./GitSection.js";
import { ClipperSection } from "./ClipperSection.js";
import { PluginSection } from "./PluginSection.js";

interface Group { id: string; name: string }
interface Member { userId: string; email: string; name: string }
interface UserRow { id: string; email: string; name: string; isAdmin: boolean; suspended: boolean }

export function AdminSettings() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [settings, setSettings] = useState<AdminSettingView[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New user form
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");

  // Delete dialog
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [reassignToId, setReassignToId] = useState<string>("");

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

  // ── User management actions ──────────────────────────────────────────────

  async function createUser() {
    if (!newUserName.trim() || !newUserEmail.trim() || !newUserPassword) return;
    setBusy(true);
    try {
      await api.createAdminUser({ name: newUserName.trim(), email: newUserEmail.trim(), password: newUserPassword });
      setNewUserName("");
      setNewUserEmail("");
      setNewUserPassword("");
      setShowCreateUser(false);
      refresh();
    } catch (err) {
      setError((err as any)?.body?.error ?? "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  async function suspendUser(id: string) {
    await api.suspendUser(id);
    refresh();
  }

  async function unsuspendUser(id: string) {
    await api.unsuspendUser(id);
    refresh();
  }

  async function deleteUser() {
    if (!deleteUserId) return;
    setBusy(true);
    try {
      await api.deleteAdminUser(deleteUserId, reassignToId || undefined);
      setDeleteUserId(null);
      setReassignToId("");
      refresh();
    } catch (err) {
      setError((err as any)?.body?.error ?? "Failed to delete user");
    } finally {
      setBusy(false);
    }
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

      <ClipperSection />

      <section className="settings-card">
        <h3>Users</h3>
        <div style={{ marginBottom: 12 }}>
          <button onClick={() => setShowCreateUser((v) => !v)} className="settings-btn primary" style={{ marginRight: 8 }}>
            {showCreateUser ? "Cancel" : "Create user"}
          </button>
        </div>
        {showCreateUser && (
          <div className="settings-group-box" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                placeholder="Name"
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                className="settings-text"
                style={{ flex: 1, minWidth: 120, marginBottom: 0 }}
              />
              <input
                placeholder="Email"
                type="email"
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
                className="settings-text"
                style={{ flex: 2, minWidth: 180, marginBottom: 0 }}
              />
              <input
                placeholder="Password"
                type="password"
                value={newUserPassword}
                onChange={(e) => setNewUserPassword(e.target.value)}
                className="settings-text"
                style={{ flex: 1, minWidth: 120, marginBottom: 0 }}
              />
              <button onClick={createUser} disabled={busy} className="settings-btn primary">
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        )}
        <table className="settings-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th style={{ width: 1 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.isAdmin ? "Admin" : "User"}</td>
                <td>
                  <span style={{ color: u.suspended ? "var(--color-danger)" : "var(--color-success)" }}>
                    {u.suspended ? "Suspended" : "Active"}
                  </span>
                </td>
                <td>
                  <div style={{ display: "flex", gap: 4 }}>
                    {u.suspended ? (
                      <button onClick={() => unsuspendUser(u.id)} className="settings-btn" style={{ padding: "2px 8px", fontSize: "var(--font-size-xs)" }}>
                        Unsuspend
                      </button>
                    ) : (
                      <button onClick={() => suspendUser(u.id)} className="settings-btn" style={{ padding: "2px 8px", fontSize: "var(--font-size-xs)" }}>
                        Suspend
                      </button>
                    )}
                    <button
                      onClick={() => setDeleteUserId(u.id)}
                      className="settings-btn danger"
                      style={{ padding: "2px 8px", fontSize: "var(--font-size-xs)" }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Delete user confirmation dialog */}
      {deleteUserId && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 2000,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.4)",
        }}>
          <div className="settings-card" style={{ maxWidth: 440, width: "100%", margin: 16 }}>
            <h3>Delete user</h3>
            <p style={{ marginBottom: 12, color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>
              This permanently removes the user account. What should happen to their content?
            </p>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <input
                  type="radio"
                  name="reassign"
                  checked={reassignToId === ""}
                  onChange={() => setReassignToId("")}
                />
                <span>Delete all content (pages, comments) along with the user</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="radio"
                  name="reassign"
                  checked={reassignToId !== ""}
                  onChange={() => setReassignToId(users.find((u) => u.id !== deleteUserId)?.id ?? "")}
                />
                <span>Reassign all content to:</span>
              </label>
              {reassignToId !== "" && (
                <select
                  value={reassignToId}
                  onChange={(e) => setReassignToId(e.target.value)}
                  className="settings-select"
                  style={{ marginTop: 4, marginLeft: 24, width: "calc(100% - 32px)" }}
                >
                  {users.filter((u) => u.id !== deleteUserId).map((u) => (
                    <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                  ))}
                </select>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setDeleteUserId(null); setReassignToId(""); }} className="settings-btn">
                Cancel
              </button>
              <button onClick={deleteUser} disabled={busy} className="settings-btn danger">
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      <PluginSection />

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
