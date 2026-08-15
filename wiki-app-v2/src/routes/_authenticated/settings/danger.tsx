import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings/danger")({
  component: DangerZoneSettingsPage,
});

// §7.1 Admin / Danger zone. Deliberately empty for now: destructive,
// instance-wide actions (repo re-sync, full wipe, encryption-key rotation)
// land with the admin-polish slice — see REBUILD.md §7 "Known limits". The
// section exists so the IA from §7.1 has an unambiguous home for them and no
// destructive control ends up scattered across other pages (§7.2).
function DangerZoneSettingsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-medium">Danger zone</h2>
        <p className="text-sm text-text-muted">
          Destructive, instance-wide actions belong here and nowhere else (§7.2).
        </p>
      </div>
      <p className="text-sm text-text-muted">
        Nothing is destructive in this build yet — future admin actions (git repository re-sync, data
        wipe, encryption-key rotation) will be placed on this page rather than embedded in page-level UI.
      </p>
    </div>
  );
}
