import { useEffect, useState } from "react";

interface AttrRow {
  id: string;
  pageId: string;
  name: string;
  value: string;
  isPromoted: boolean;
  position: number;
}

export function AttributesPanel({ branchId }: { branchId: string }) {
  const [attrs, setAttrs] = useState<AttrRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchAttrs = () => {
    setLoading(true);
    fetch(`/api/branches/${branchId}/attributes`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setAttrs(d.attributes ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => fetchAttrs(), [branchId]);

  const addAttr = async () => {
    if (!newName.trim()) return;
    const res = await fetch(`/api/branches/${branchId}/attributes`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), value: newValue.trim() }),
    });
    if (res.ok) { setNewName(""); setNewValue(""); fetchAttrs(); }
    else { const d = await res.json().catch(() => ({})); alert((d as any).error ?? "Failed"); }
  };

  const togglePromoted = async (attr: AttrRow) => {
    await fetch(`/api/attributes/${attr.id}`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branchId, isPromoted: !attr.isPromoted }),
    });
    fetchAttrs();
  };

  const updateAttr = async (id: string, name: string, value: string) => {
    await fetch(`/api/attributes/${id}`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branchId, name, value }),
    });
    setEditingId(null);
    fetchAttrs();
  };

  const deleteAttr = async (id: string) => {
    await fetch(`/api/attributes/${id}?branchId=${encodeURIComponent(branchId)}`, { method: "DELETE", credentials: "include" });
    fetchAttrs();
  };

  const promoted = attrs.filter(a => a.isPromoted);
  const rest = attrs.filter(a => !a.isPromoted);

  return (
    <div className="attributes-panel">
      <h4 className="attributes-heading">Attributes</h4>

      {/* Promoted — always visible */}
      {promoted.map(a => (
        <div key={a.id} className="attr-row promoted">
          <span className="attr-name">{a.name}</span>
          <span className="attr-value">{a.value || "—"}</span>
          <button className="attr-btn" onClick={() => togglePromoted(a)} title="Un-promote">★</button>
        </div>
      ))}

      {/* Add new */}
      <div className="attr-add">
        <input className="attr-input" placeholder="Name" value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") addAttr(); }} />
        <input className="attr-input" placeholder="Value" value={newValue}
          onChange={e => setNewValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") addAttr(); }} />
        <button className="attr-btn add" onClick={addAttr}>+</button>
      </div>

      {/* All attributes (expandable) */}
      {rest.length > 0 && (
        <details className="attr-details">
          <summary className="attr-summary">All ({rest.length})</summary>
          {rest.map(a => (
            <div key={a.id} className="attr-row">
              {editingId === a.id ? (
                <>
                  <input className="attr-input" defaultValue={a.name}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        const name = (e.target as HTMLInputElement).value;
                        const val = ((e.target as HTMLInputElement).nextElementSibling as HTMLInputElement).value;
                        updateAttr(a.id, name, val);
                      }
                    }} />
                  <input className="attr-input" defaultValue={a.value}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        const val = (e.target as HTMLInputElement).value;
                        const name = ((e.target as HTMLInputElement).previousElementSibling as HTMLInputElement).value;
                        updateAttr(a.id, name, val);
                      }
                    }} />
                </>
              ) : (
                <>
                  <span className="attr-name">{a.name}</span>
                  <span className="attr-value">{a.value || "—"}</span>
                  <button className="attr-btn" onClick={() => setEditingId(a.id)} title="Edit">✎</button>
                </>
              )}
              <button className="attr-btn" onClick={() => togglePromoted(a)} title="Promote">☆</button>
              <button className="attr-btn danger" onClick={() => deleteAttr(a.id)} title="Delete">×</button>
            </div>
          ))}
        </details>
      )}

      {loading && <div className="attr-loading">Loading…</div>}
    </div>
  );
}
