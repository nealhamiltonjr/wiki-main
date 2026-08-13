import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { authClient, useSession } from "@/api/authClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/settings/profile")({
  component: ProfileSettingsPage,
});

function ProfileSettingsPage() {
  const { data: session } = useSession();
  const user = session?.user;

  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"" | "ok" | "error">("");
  const [saveError, setSaveError] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [pwStatus, setPwStatus] = useState<"" | "ok" | "error">("");
  const [pwError, setPwError] = useState("");

  if (!user) return null;

  async function saveName() {
    setSaving(true);
    setSaveStatus("");
    try {
      await authClient.updateUser({ name: name.trim() });
      setSaveStatus("ok");
    } catch {
      setSaveStatus("error");
      setSaveError("Could not update your name");
    } finally {
      setSaving(false);
    }
  }

  async function changePassword() {
    if (newPassword.length < 8) {
      setPwStatus("error");
      setPwError("New password must be at least 8 characters");
      return;
    }
    setChanging(true);
    setPwStatus("");
    try {
      await authClient.changePassword({ currentPassword, newPassword });
      setPwStatus("ok");
      setCurrentPassword("");
      setNewPassword("");
    } catch {
      setPwStatus("error");
      setPwError("Could not change password — check your current password");
    } finally {
      setChanging(false);
    }
  }

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-medium">Profile</h2>
        <p className="text-sm text-text-muted">Your own account settings.</p>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Display name</h3>
        <div className="flex gap-2">
          <input
            aria-label="Display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <Button size="sm" onClick={() => void saveName()} disabled={saving || name.trim() === user.name}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
        {saveStatus === "ok" && <p className="text-xs text-success">Name updated.</p>}
        {saveStatus === "error" && <p className="text-xs text-danger">{saveError}</p>}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Account</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <dt className="w-24 text-text-muted">Email</dt>
            <dd className="flex items-center gap-2">
              {user.email}
              {user.emailVerified ? <Badge variant="outline">verified</Badge> : <Badge variant="outline">unverified</Badge>}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="w-24 text-text-muted">Role</dt>
            <dd>{user.isAdmin ? <Badge>Admin</Badge> : <span className="text-text-secondary">Member</span>}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Change password</h3>
        <div className="space-y-2">
          <input
            aria-label="Current password"
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <input
            aria-label="New password"
            type="password"
            placeholder="New password (min 8 chars)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <Button size="sm" variant="outline" onClick={() => void changePassword()} disabled={changing || !currentPassword || !newPassword}>
            {changing ? "Changing…" : "Change password"}
          </Button>
        </div>
        {pwStatus === "ok" && <p className="text-xs text-success">Password changed.</p>}
        {pwStatus === "error" && <p className="text-xs text-danger">{pwError}</p>}
      </section>
    </div>
  );
}
