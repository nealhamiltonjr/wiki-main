import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@/api/authClient";
import { request } from "@/api/client";
import { Badge } from "@/components/ui/badge";

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

function UserSettingsPage() {
  const { data: session } = useSession();
  const me = session?.user;
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<UserRow[]>("/api/users");
      setUsers(list);
    } catch {
      setError("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function patch(id: string, body: { isAdmin?: boolean; suspended?: boolean }) {
    try {
      const updated = await request<UserRow>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-medium">Users</h2>
        <p className="text-sm text-text-muted">
          Admin user management — role changes and suspension. You cannot demote or suspend your own account.
        </p>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
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
            {users.map((u) => (
              <tr key={u.id} className="border-b border-border">
                <td className="py-2 pr-4">
                  {u.name}
                  {u.id === me?.id && <span className="ml-1 text-xs text-text-muted">(you)</span>}
                </td>
                <td className="py-2 pr-4 text-text-muted">{u.email}</td>
                <td className="py-2 pr-4">{u.isAdmin ? <Badge>Admin</Badge> : <span className="text-text-secondary">Member</span>}</td>
                <td className="py-2 pr-4">
                  {u.suspended ? <span className="text-danger">Suspended</span> : <span className="text-success">Active</span>}
                </td>
                <td className="py-2">
                  {u.id !== me?.id && (
                    <div className="flex gap-3">
                      <button type="button" className="text-xs text-text-secondary hover:underline" onClick={() => void patch(u.id, { isAdmin: !u.isAdmin })}>
                        {u.isAdmin ? "Remove admin" : "Make admin"}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-danger hover:underline"
                        onClick={() => void patch(u.id, { suspended: !u.suspended })}
                      >
                        {u.suspended ? "Unsuspend" : "Suspend"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
