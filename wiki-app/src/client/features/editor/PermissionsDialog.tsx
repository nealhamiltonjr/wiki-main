import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type BranchGrant } from "../../api/client.js";

/**
 * Per-branch group permissions (§7.12g). The permission ENGINE already existed;
 * this dialog is the API surface's UI. Semantics (documented, tested):
 * a branch with ANY explicit grant becomes a restricted boundary - the nearest
 * such boundary in a chain fully decides access for that subtree, overriding
 * space roles and visibility. An empty grant list clears the boundary.
 */
export function PermissionsDialog({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const [grants, setGrants] = useState<BranchGrant[] | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [pendingGroup, setPendingGroup] = useState<string>("");
  const [pendingRole, setPendingRole] = useState<"viewer" | "editor">("viewer");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getBranchPermissions(branchId).then((res) => {
      setGrants(res.grants);
      setGroups(res.groups);
    }).catch(() => setError("Failed to load permissions"));
  }, [branchId]);

  const addGrant = useCallback(() => {
    if (!pendingGroup || !grants) return;
    const group = groups.find((g) => g.id === pendingGroup);
    if (!group) return;
    setGrants([...grants, { groupId: group.id, groupName: group.name, role: pendingRole }]);
    setPendingGroup("");
  }, [pendingGroup, pendingRole, grants, groups]);

  const updateRole = useCallback((groupId: string, role: "viewer" | "editor") => {
    setGrants((cur) => cur?.map((g) => (g.groupId === groupId ? { ...g, role } : g)) ?? null);
  }, []);

  const removeGrant = useCallback((groupId: string) => {
    setGrants((cur) => cur?.filter((g) => g.groupId !== groupId) ?? null);
  }, []);

  const save = useCallback(async () => {
    if (!grants) return;
    setSaving(true);
    setError(null);
    try {
      await api.setBranchPermissions(
        branchId,
        grants.map((g) => ({ groupId: g.groupId, role: g.role }))
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? String((err.body as any)?.error ?? err.status) : "Failed to save");
      setSaving(false);
    }
  }, [branchId, grants, onClose]);

  const availableGroups = groups.filter((g) => !grants?.some((gr) => gr.groupId === g.id));

  return (
    <div className="perm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="perm-dialog" role="dialog" aria-label="Page permissions">
        <div className="perm-dialog-header">
          <span>Page permissions</span>
          <button className="perm-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="perm-hint">
          A page with explicit permissions is a <strong>restricted boundary</strong>: only the listed
          groups can view it, overriding space roles and public visibility for this page and its
          descendants (nearest boundary wins). No grants = inherited space access.
        </p>

        {grants === null ? (
          <div className="perm-empty">Loading…</div>
        ) : grants.length === 0 ? (
          <div className="perm-empty">No explicit permissions — access is inherited from the space.</div>
        ) : (
          <table className="perm-table">
            <thead>
              <tr><th>Group</th><th>Role</th><th /></tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.groupId}>
                  <td>{g.groupName}</td>
                  <td>
                    <select
                      value={g.role}
                      onChange={(e) => updateRole(g.groupId, e.target.value as "viewer" | "editor")}
                      className="perm-role-select"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                  </td>
                  <td>
                    <button className="perm-remove" onClick={() => removeGrant(g.groupId)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {availableGroups.length > 0 && (
          <div className="perm-add-row">
            <select value={pendingGroup} onChange={(e) => setPendingGroup(e.target.value)} className="perm-group-select">
              <option value="">Select group…</option>
              {availableGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <select value={pendingRole} onChange={(e) => setPendingRole(e.target.value as "viewer" | "editor")} className="perm-role-select">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <button className="wiki-page-action" onClick={addGrant} disabled={!pendingGroup}>Add</button>
          </div>
        )}

        {error && <div className="perm-error">{error}</div>}

        <div className="perm-dialog-footer">
          <button className="wiki-page-action" onClick={onClose}>Cancel</button>
          <button className="wiki-page-action primary" onClick={save} disabled={saving || grants === null}>
            {saving ? "Saving…" : "Save permissions"}
          </button>
        </div>
      </div>
    </div>
  );
}
