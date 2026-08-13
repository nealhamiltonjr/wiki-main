import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { request } from "@/api/client";

export const Route = createFileRoute("/_authenticated/settings/spaces")({
  component: SpaceSettingsPage,
});

interface SpaceRow {
  id: string;
  name: string;
  defaultRole: "editor" | "viewer" | "none";
  createdAt: string;
}

const ROLE_LABELS: Record<SpaceRow["defaultRole"], string> = {
  editor: "Open — any user can edit",
  viewer: "Open — any user can read",
  none: "Members-only (safe default)",
};

function SpaceSettingsPage() {
  const [spaces, setSpaces] = useState<SpaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<SpaceRow[]>("/api/spaces");
      setSpaces(list);
      const counts: Record<string, number> = {};
      await Promise.all(
        list.map(async (s) => {
          try {
            const p = await request<{ members: unknown[] }>(`/api/spaces/${s.id}/permissions`);
            counts[s.id] = p.members.length;
          } catch {
            counts[s.id] = 0;
          }
        })
      );
      setMemberCounts(counts);
    } catch {
      setError("Failed to load spaces");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setDefaultRole(spaceId: string, defaultRole: SpaceRow["defaultRole"]) {
    try {
      await request(`/api/spaces/${spaceId}/default-role`, {
        method: "PUT",
        body: JSON.stringify({ defaultRole }),
      });
      setSpaces((prev) => prev.map((s) => (s.id === spaceId ? { ...s, defaultRole } : s)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-medium">Spaces</h2>
        <p className="text-sm text-text-muted">
          Per-space default role for authenticated users with no explicit membership or group grant.
        </p>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : spaces.length === 0 ? (
        <p className="text-sm text-text-muted">No spaces.</p>
      ) : (
        <div className="space-y-3">
          {spaces.map((s) => (
            <div key={s.id} className="rounded-md border border-border p-4">
              <div className="flex items-baseline justify-between">
                <h3 className="font-medium">{s.name}</h3>
                <span className="text-xs text-text-muted">{memberCounts[s.id] ?? "…"} member(s)</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-text-muted">Default role</span>
                <select
                  value={s.defaultRole}
                  onChange={(e) => void setDefaultRole(s.id, e.target.value as SpaceRow["defaultRole"])}
                  aria-label={`Default role for ${s.name}`}
                  className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="none">none</option>
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                </select>
              </div>
              <p className="mt-1 text-xs text-text-muted">{ROLE_LABELS[s.defaultRole]}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
