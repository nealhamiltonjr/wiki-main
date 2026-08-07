import { useEffect, useState } from "react";
import type { AdminSettingView } from "../../api/client.js";
import { api } from "../../api/client.js";
import { useSession } from "../../api/authClient.js";
import { SettingRow } from "./SettingRow.js";
import { GitSection } from "./GitSection.js";
import { ClipperSection } from "./ClipperSection.js";
import { Users, Settings, Shield, GitBranch } from "lucide-react";

interface Group { id: string; name: string; capabilities?: string[] }
interface Member { userId: string; email: string; name: string }
interface UserRow { id: string; email: string; name: string; isAdmin: boolean; suspended: boolean }

const ALL_CAPABILITIES = [
  { key: "admin.*", label: "Full admin" },
  { key: "admin.users", label: "User management" },
  { key: "admin.groups", label: "Group management" },
  { key: "admin.settings", label: "System settings" },
  { key: "admin.logs", label: "View logs" },
  { key: "admin.git", label: "Git operations" },
];

const TABS = [
  { id: "users", label: "Users & groups", icon: Users },
  { id: "sys", label: "System", icon: Settings },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "debug", label: "Debug", icon: Shield },
] as const;

export function AdminSettings() {
  const { data: session } = useSession();
  const [activeTab, setActiveTab] = useState<string>("users");
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [settings, setSettings] = useState<AdminSettingView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // User create form
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");

  // User edit
  const [editUserId, setEditUserId] = useState<string | null>(null);
  const [editUserGroups, setEditUserGroups] = useState<string[]>([]);

  // Delete dialog
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [reassignToId, setReassignToId] = useState<string>("");

  // Groups
  const [newGroupName, setNewGroupName] = useState("");
  const [editGroupCaps, setEditGroupCaps] = useState<Record<string, string[]>>({});

  // Debug
  const [logs, setLogs] = useState<{ id: string; level: string; source: string; message: string; meta: unknown; createdAt: string }[]>([]);
  const [logFilter, setLogFilter] = useState("");

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

  useEffect(() => { refresh(); }, []);

  // ── User management ──────────────────────────────────────────────────────

  async function createUser() {
    if (!newUserName.trim() || !newUserEmail.trim() || !newUserPassword) return;
    setBusy(true);
    try {
      await api.createAdminUser({ name: newUserName.trim(), email: newUserEmail.trim(), password: newUserPassword });
      setNewUserName(""); setNewUserEmail(""); setNewUserPassword(""); setShowCreateUser(false);
      refresh();
    } catch (err) {
      setError((err as any)?.body?.error ?? "Failed to create user");
    } finally { setBusy(false); }
  }

  async function suspendUser(id: string) { await api.suspendUser(id); refresh(); }
  async function unsuspendUser(id: string) { await api.unsuspendUser(id); refresh(); }

  async function deleteUser() {
    if (!deleteUserId) return;
    setBusy(true);
    try {
      await api.deleteAdminUser(deleteUserId, reassignToId || undefined);
      setDeleteUserId(null); setReassignToId(""); refresh();
    } catch (err) {
      setError((err as any)?.body?.error ?? "Failed to delete user");
    } finally { setBusy(false); }
  }

  function openEditUser(userId: string) {
    const userGroupIds = Object.entries(members)
      .filter(([, ms]) => ms.some((m) => m.userId === userId))
      .map(([gid]) => gid);
    setEditUserGroups(userGroupIds);
    setEditUserId(userId);
  }

  async function saveEditUser() {
    if (!editUserId) return;
    // Add/remove group memberships to match editUserGroups.
    const current = Object.entries(members)
      .filter(([, ms]) => ms.some((m) => m.userId === editUserId))
      .map(([gid]) => gid);
    const toAdd = editUserGroups.filter((g) => !current.includes(g));
    const toRemove = current.filter((g) => !editUserGroups.includes(g));
    for (const gid of toAdd) await api.addGroupMember(gid, editUserId);
    for (const gid of toRemove) await api.removeGroupMember(gid, editUserId);
    setEditUserId(null);
    refresh();
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  async function createGroup() {
    if (!newGroupName.trim()) return;
    const caps = editGroupCaps["new"] ?? [];
    await api.createGroup(newGroupName.trim(), caps);
    setNewGroupName(""); setEditGroupCaps((prev) => { const c = { ...prev }; delete c["new"]; return c; });
    refresh();
  }

  async function deleteGroup(id: string) { await api.deleteGroup(id); refresh(); }
  async function addMember(groupId: string, userId: string) {
    if (!userId) return;
    await api.addGroupMember(groupId, userId); refresh();
  }
  async function removeMember(groupId: string, userId: string) {
    await api.removeGroupMember(groupId, userId); refresh();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async function saveSetting(key: string, value: unknown) { await api.setSetting(key, value); refresh(); }
  async function deleteSetting(key: string) { await api.deleteSetting(key); refresh(); }

  // ── Debug ─────────────────────────────────────────────────────────────────

  async function loadLogs() {
    try {
      const l = await api.listAdminLogs();
      setLogs(l);
    } catch { /* ignore */ }
  }
  useEffect(() => { if (activeTab === "debug") loadLogs(); }, [activeTab]);

  // ── Settings sections ─────────────────────────────────────────────────────

  const sections = new Map<string, AdminSettingView[]>();
  for (const s of settings) {
    const list = sections.get(s.section) ?? [];
    list.push(s); sections.set(s.section, list);
  }
  const sectionOrder = ["General", "Email", "Git", "Sync", "Security", "Custom"];
  const orderedSections = [...sections.entries()].sort(([a], [b]) => {
    const ia = sectionOrder.indexOf(a), ib = sectionOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const filteredLogs = logFilter
    ? logs.filter((l) => l.message.toLowerCase().includes(logFilter.toLowerCase()) || l.source.toLowerCase().includes(logFilter.toLowerCase()))
    : logs;

  return (
    <div style={{ maxWidth: "none" }}>
      <h2>Administration</h2>
      {error && <div className="wiki-banner">{error}</div>}

      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--color-border)", marginBottom: 24 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`settings-tab ${activeTab === t.id ? "active" : ""}`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* TAB: Users & Groups */}
      {activeTab === "users" && (
        <>
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
                  <input placeholder="Name" value={newUserName} onChange={(e) => setNewUserName(e.target.value)} className="settings-text" style={{ flex: 1, minWidth: 120, marginBottom: 0 }} />
                  <input placeholder="Email" type="email" value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} className="settings-text" style={{ flex: 2, minWidth: 180, marginBottom: 0 }} />
                  <input placeholder="Password" type="password" value={newUserPassword} onChange={(e) => setNewUserPassword(e.target.value)} className="settings-text" style={{ flex: 1, minWidth: 120, marginBottom: 0 }} />
                  <button onClick={createUser} disabled={busy} className="settings-btn primary">{busy ? "Creating…" : "Create"}</button>
                </div>
              </div>
            )}
            <table className="settings-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th style={{ width: 1 }}>Actions</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td><td>{u.email}</td><td>{u.isAdmin ? "Admin" : "User"}</td>
                    <td><span style={{ color: u.suspended ? "var(--color-danger)" : "var(--color-success)" }}>{u.suspended ? "Suspended" : "Active"}</span></td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button onClick={() => openEditUser(u.id)} className="settings-btn" style={{ padding: "2px 8px", fontSize: "var(--font-size-xs)" }}>Edit</button>
                        {u.suspended
                          ? <button onClick={() => unsuspendUser(u.id)} className="settings-btn" style={{ padding: "2px 8px", fontSize: "var(--font-size-xs)" }}>Unsuspend</button>
                          : <button onClick={() => suspendUser(u.id)} className="settings-btn" style={{ padding: "2px 8px", fontSize: "var(--font-size-xs)" }}>Suspend</button>}
                        <button
                          onClick={() => { setDeleteUserId(u.id); setReassignToId(""); }}
                          className="settings-btn danger"
                          style={{ padding: "2px 8px", fontSize: "var(--font-size-xs)" }}
                          disabled={u.id === session?.user.id}
                          title={u.id === session?.user.id ? "You cannot delete your own account" : undefined}
                        >Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Edit user modal */}
          {editUserId && (
            <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}>
              <div className="settings-card" style={{ maxWidth: 400, width: "100%", margin: 16 }}>
                <h3>Edit user: {users.find((u) => u.id === editUserId)?.name}</h3>
                <p style={{ marginBottom: 8, color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>Group memberships</p>
                {groups.map((g) => (
                  <label key={g.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <input type="checkbox" checked={editUserGroups.includes(g.id)} onChange={(e) => {
                      setEditUserGroups(e.target.checked ? [...editUserGroups, g.id] : editUserGroups.filter((x) => x !== g.id));
                    }} />
                    {g.name}
                  </label>
                ))}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                  <button onClick={() => setEditUserId(null)} className="settings-btn">Cancel</button>
                  <button onClick={saveEditUser} className="settings-btn primary">Save</button>
                </div>
              </div>
            </div>
          )}

          {/* Delete user modal */}
          {deleteUserId && (
            <div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}>
              <div className="settings-card" style={{ maxWidth: 440, width: "100%", margin: 16 }}>
                <h3>Delete user</h3>
                <p style={{ marginBottom: 12, color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>
                  This permanently removes the user account. What should happen to their content?
                </p>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <input type="radio" name="reassign" checked={reassignToId === ""} onChange={() => setReassignToId("")} />
                    <span>Delete all content (pages, comments) along with the user</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="radio" name="reassign" checked={reassignToId !== ""} onChange={() => setReassignToId(users.find((u) => u.id !== deleteUserId)?.id ?? "")} />
                    <span>Reassign content to:</span>
                  </label>
                  {reassignToId !== "" && (
                    <select value={reassignToId} onChange={(e) => setReassignToId(e.target.value)} className="settings-select" style={{ marginTop: 4, marginLeft: 24, width: "calc(100% - 32px)" }}>
                      {users.filter((u) => u.id !== deleteUserId).map((u) => (<option key={u.id} value={u.id}>{u.name} ({u.email})</option>))}
                    </select>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => api.exportUserData(deleteUserId)} className="settings-btn" style={{ marginRight: "auto" }}>Export data</button>
                  <button onClick={() => { setDeleteUserId(null); setReassignToId(""); }} className="settings-btn">Cancel</button>
                  <button onClick={deleteUser} disabled={busy} className="settings-btn danger">{busy ? "Deleting…" : "Delete permanently"}</button>
                </div>
              </div>
            </div>
          )}

          <section className="settings-card">
            <h3>Groups</h3>
            {groups.map((g) => (
              <div key={g.id} className="settings-group-box">
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{g.name}</strong>
                  <button onClick={() => deleteGroup(g.id)} className="settings-btn danger" style={{ padding: "2px 10px" }}>Delete</button>
                </div>
                <div style={{ marginTop: 4, fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>
                  Capabilities:{" "}
                  {(g.capabilities || []).length ? (g.capabilities || []).join(", ") : "none"}
                </div>
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: "var(--font-size-xs)", marginBottom: 4 }}>Capabilities</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {ALL_CAPABILITIES.map((cap) => {
                      const current = editGroupCaps[g.id] !== undefined ? editGroupCaps[g.id]! : (g.capabilities || []);
                      return (
                      <label key={cap.key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--font-size-sm)", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={current.includes(cap.key)}
                          onChange={async (e) => {
                            const next = e.target.checked
                              ? [...current, cap.key]
                              : current.filter((c) => c !== cap.key);
                            setEditGroupCaps((prev) => ({ ...prev, [g.id]: next }));
                            await api.updateGroupCapabilities(g.id, next);
                            refresh();
                          }}
                        />
                        {cap.label}
                      </label>
                      );
                    })}
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  {(members[g.id] ?? []).map((m) => (
                    <div key={m.userId} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                      <span>{m.name} ({m.email})</span>
                      <button onClick={() => removeMember(g.id, m.userId)} className="wiki-icon-btn">Remove</button>
                    </div>
                  ))}
                  <select defaultValue="" onChange={(e) => { addMember(g.id, e.target.value); e.target.value = ""; }} className="settings-select" style={{ marginTop: 4 }}>
                    <option value="" disabled>Add member…</option>
                    {users.filter((u) => !(members[g.id] ?? []).some((m) => m.userId === u.id)).map((u) => (<option key={u.id} value={u.id}>{u.name} ({u.email})</option>))}
                  </select>
                </div>
              </div>
            ))}
            <div style={{ display: "flex", gap: 4 }}>
              <input placeholder="New group name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} className="settings-text" style={{ marginBottom: 0 }} />
              <button onClick={createGroup} className="settings-btn primary">Create group</button>
            </div>
          </section>
        </>
      )}

      {/* TAB: System Settings */}
      {activeTab === "sys" && (
        <>
          {orderedSections.map(([section, defs]) => (
            <section className="settings-card" key={section}>
              <h3>{section}</h3>
              {defs.map((s) => (
                <SettingRow key={s.key} setting={s} onSave={saveSetting} onDelete={section === "Custom" ? deleteSetting : undefined} />
              ))}
            </section>
          ))}
        </>
      )}

      {/* TAB: Git (plugin toggles live on the per-user Settings page now) */}
      {activeTab === "git" && (
        <>
          <GitSection />
          <ClipperSection />
        </>
      )}

      {/* TAB: Debug */}
      {activeTab === "debug" && (
        <section className="settings-card">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <h3>System logs</h3>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                placeholder="Filter…"
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                className="settings-text"
                style={{ marginBottom: 0, width: 200 }}
              />
              <button onClick={loadLogs} className="settings-btn primary">Refresh</button>
            </div>
          </div>
          <div style={{ maxHeight: 500, overflow: "auto", fontFamily: "monospace", fontSize: "var(--font-size-sm)" }}>
            <table className="settings-table" style={{ width: "100%" }}>
              <thead><tr><th>Time</th><th>Level</th><th>Source</th><th>Message</th></tr></thead>
              <tbody>
                {filteredLogs.map((l) => (
                  <tr key={l.id} style={{ opacity: l.level === "debug" ? 0.6 : 1 }}>
                    <td style={{ whiteSpace: "nowrap" }}>{l.createdAt}</td>
                    <td>
                      <span style={{
                        color: l.level === "error" ? "var(--color-danger)" : l.level === "warn" ? "var(--color-warning, #e6a700)" : "var(--color-text-secondary)",
                        fontWeight: l.level === "error" ? 600 : 400,
                      }}>
                        {l.level}
                      </span>
                    </td>
                    <td>{l.source}</td>
                    <td style={{ wordBreak: "break-word" }}>{l.message}</td>
                  </tr>
                ))}
                {filteredLogs.length === 0 && (
                  <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--color-text-secondary)" }}>No log entries</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
