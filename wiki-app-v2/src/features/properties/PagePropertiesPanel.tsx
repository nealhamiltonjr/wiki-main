import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "../../api/client.js";

interface Attr {
  id: string;
  name: string;
  value: string;
  valuePageId: string | null;
  isPromoted: boolean;
}

export function PagePropertiesPanel({ pageId, canEdit }: { pageId: string; canEdit: boolean }) {
  const [attrs, setAttrs] = useState<Attr[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [promoted, setPromoted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      setAttrs(await api.listAttributes(pageId));
    } catch {
      setAttrs([]);
    }
  }

  useEffect(() => { void load(); }, [pageId]);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      await api.addAttribute(pageId, { name: trimmed, value, isPromoted: promoted });
      setName("");
      setValue("");
      setPromoted(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add property");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api.removeAttribute(id);
    await load();
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-text-secondary">Page properties</h3>
        <p className="text-xs text-text-muted">Labels/values attached to this page (promoted labels show in the sidebar).</p>
      </div>

      {attrs.length === 0 ? (
        <p className="text-xs text-text-muted">No properties yet.</p>
      ) : (
        <ul className="space-y-1">
          {attrs.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-text-secondary">
                <span className="font-medium">{a.name}</span>
                {a.value ? `: ${a.value}` : ""}
                {a.valuePageId ? " → linked" : ""}
                {a.isPromoted ? " · promoted" : ""}
              </span>
              {canEdit && (
                <button type="button" onClick={() => void remove(a.id)} aria-label={`Remove ${a.name}`} className="text-danger">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="space-y-2 border-t border-border pt-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Label" className="w-full rounded border bg-background px-2 py-1 text-sm" />
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" className="w-full rounded border bg-background px-2 py-1 text-sm" />
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input type="checkbox" checked={promoted} onChange={(e) => setPromoted(e.target.checked)} />
            Promoted (show in sidebar)
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <button type="button" onClick={() => void add()} disabled={busy || !name.trim()} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" /> Add property
          </button>
        </div>
      )}
    </div>
  );
}
