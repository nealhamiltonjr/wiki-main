import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api/client.js";

interface SpaceMember { userId: string; role: string; email: string; name: string }
interface GroupGrant { id: string; groupId: string; role: string; groupName: string }

/**
 * Space-level permissions (§ space roles): default role for new members,
 * explicit member roles, and group-wide grants. Rendered inside the page
 * permissions dialog when the caller is a space admin (the server enforces
 * that with a 403; this panel simply hides itself in that case, so page
 * editors see only the per-branch section).
 */
export function SpacePermissionsPanel({ spaceId }: { spaceId: string }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [defaultRole, setDefaultRole] = useState("editor");
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [grants, setGrants] = useState<GroupGrant[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<{ id: string; name: string; email: string }[]>([]);
  const [pendingUserId, setPendingUserId] = useState("");
  const [pendingMemberRole, setPendingMemberRole] = useState("viewer");
  const [pendingGroupId, setPendingGroupId] = useState("");
  const [pendingGrantRole, setPendingGrantRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getSpacePermissions(spaceId)
      .then((res) => {
        if (cancelled) return;
        setAuthorized(true);
        setDefaultRole(res.defaultRole);
        setMembers(res.members);
        setGrants(res.groupGrants);
        setGroups(res.groups);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) setAuthorized(false);
        else setError("Failed to load space permissions");
      });
    return () => { cancelled = true; };
  }, [spaceId]);

  // Debounced user search for the "add member" picker.
  useEffect(() => {
    if (!userQuery.trim()) { setUserResults([]); return; }
    const timer = setTimeout(() => {
      api.searchUsers(userQuery.trim()).then((res) => setUserResults(res.users)).catch(() => setUserResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [userQuery]);

  const saveDefaultRole = useCallback(async (role: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.setSpaceDefaultRole(spaceId, role);
      setDefaultRole(role);
    } catch (err) {
      setError(err instanceof ApiError ? String((err.body as any)?.error ?? err.status) : "Failed to save default role");
    } finally {
      setSaving(false);
    }
  }, [spaceId]);

  const addMember = useCallback(async () => {
    if (!pendingUserId) return;
    setSaving(true);
    setError(null);
    try {
      await api.addSpaceMember(spaceId, pendingUserId, pendingMemberRole);
      const res = await api.getSpacePermissions(spaceId);
      setMembers(res.members);
      setPendingUserId("");
      setUserQuery("");
      setUserResults([]);
    } catch (err) {
      setError(err instanceof ApiError ? String((err.body as any)?.error ?? err.status) : "Failed to add member");
    } finally {
      setSaving(false);
    }
  }, [spaceId, pendingUserId, pendingMemberRole]);

  const removeMember = useCallback(async (userId: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.removeSpaceMember(spaceId, userId);
      setMembers((cur) => cur.filter((m) => m.userId !== userId));
    } catch (err) {
      setError(err instanceof ApiError ? String((err.body as any)?.error ?? err.status) : "Failed to remove member");
    } finally {
      setSaving(false);
    }
  }, [spaceId]);

  const changeMemberRole = useCallback(async (userId: string, role: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.addSpaceMember(spaceId, userId, role);
      setMembers((cur) => cur.map((m) => (m.userId === userId ? { ...m, role } : m)));
    } catch (err) {
      setError(err instanceof ApiError ? String((err.body as any)?.error ?? err.status) : "Failed to update member role");
    } finally {
      setSaving(false);
    }
  }, [spaceId]);

  const addGrant = useCallback(async () => {
    if (!pendingGroupId) return;
    setSaving(true);
    setError(null);
    try {
      await api.addSpaceGroupGrant(spaceId, pendingGroupId, pendingGrantRole);
      const res = await api.getSpacePermissions(spaceId);
      setGrants(res.groupGrants);
      setPendingGroupId("");
    } catch (err) {
      setError(err instanceof ApiError ? String((err.body as any)?.error ?? err.status) : "Failed to add group grant");
    } finally {
      setSaving(false);
    }
  }, [spaceId, pendingGroupId, pendingGrantRole]);

  const removeGrant = useCallback(async (grantId: string) => {
    setSaving(true);
    setError(null);
    try {
      await api.removeSpaceGroupGrant(spaceId, grantId);
      setGrants((cur) => cur.filter((g) => g.id !== grantId));
    } catch (err) {
      setError(err instanceof ApiError ? String((err.body as any)?.error ?? err.status) : "Failed to remove group grant");
    } finally {
      setSaving(false);
    }
  }, [spaceId]);

  if (authorized === null) return <div className="perm-empty">Loading space permissions…</div>;
  if (authorized === false) return null; // not a space admin - page-level dialog only

  const availableGroups = groups.filter((g) => !grants.some((gr) => gr.groupId === g.id));

  return (
    <section className="settings-card" style={{ marginTop: 16 }}>
      <h3>Space permissions</h3>
      <p className="hint">
        These apply to the whole space. A page with explicit permissions below is a restricted
        boundary that overrides space access for that page and its descendants.
      </p>

      {error && <div className="perm-error">{error}</div>}

      <div className="perm-hint" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <label htmlFor="space-default-role" style={{ fontWeight: 600 }}>Default role for space members</label>
        <select
          id="space-default-role"
          value={defaultRole}
          onChange={(e) => saveDefaultRole(e.target.value)}
          className="perm-role-select"
          disabled={saving}
        >
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
          <option value="none">No access</option>
        </select>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Members</div>
        {members.length === 0 && <div className="perm-empty">No explicit members.</div>}
        <table className="perm-table">
          <thead>
            <tr><th>User</th><th>Role</th><th /></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>{m.name || m.email}</td>
                <td>
                  <select
                    value={m.role}
                    onChange={(e) => changeMemberRole(m.userId, e.target.value)}
                    className="perm-role-select"
                    disabled={saving}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td><button className="perm-remove" onClick={() => removeMember(m.userId)} disabled={saving}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="perm-add-row" style={{ marginTop: 8 }}>
          <input
            type="text"
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder="Search users…"
            className="perm-group-select"
            style={{ width: 180 }}
          />
          {userResults.length > 0 && (
            <select value={pendingUserId} onChange={(e) => setPendingUserId(e.target.value)} className="perm-group-select">
              <option value="">Select user…</option>
              {userResults.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email} ({u.email})</option>
              ))}
            </select>
          )}
          <select value={pendingMemberRole} onChange={(e) => setPendingMemberRole(e.target.value)} className="perm-role-select">
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <button className="wiki-page-action" onClick={addMember} disabled={!pendingUserId || saving}>Add</button>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Group access</div>
        {grants.length === 0 && <div className="perm-empty">No group grants.</div>}
        <table className="perm-table">
          <thead>
            <tr><th>Group</th><th>Role</th><th /></tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>{g.groupName}</td>
                <td>{g.role}</td>
                <td><button className="perm-remove" onClick={() => removeGrant(g.id)} disabled={saving}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>

        {availableGroups.length > 0 && (
          <div className="perm-add-row" style={{ marginTop: 8 }}>
            <select value={pendingGroupId} onChange={(e) => setPendingGroupId(e.target.value)} className="perm-group-select">
              <option value="">Select group…</option>
              {availableGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <select value={pendingGrantRole} onChange={(e) => setPendingGrantRole(e.target.value)} className="perm-role-select">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
            <button className="wiki-page-action" onClick={addGrant} disabled={!pendingGroupId || saving}>Add</button>
          </div>
        )}
      </div>
    </section>
  );
}
