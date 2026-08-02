import { useEffect, useState } from "react";

export interface BacklinkEntry {
  sourceBranchId: string;
  sourceSlug: string;
  sourceTitle: string | null;
  targetBlockId: string | null;
}

export function BacklinksPanel({ pageId, onNavigate }: { pageId: string; onNavigate: (branchId: string) => void }) {
  const [links, setLinks] = useState<BacklinkEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pages/${pageId}/backlinks`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setLinks(data.backlinks ?? []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pageId]);

  if (loading) return <div className="backlinks-panel"><p className="backlinks-empty">Loading…</p></div>;
  if (links.length === 0) return <div className="backlinks-panel"><p className="backlinks-empty">No backlinks yet.</p></div>;

  return (
    <div className="backlinks-panel">
      <h3 className="backlinks-heading">Backlinks ({links.length})</h3>
      <ul className="backlinks-list">
        {links.map((l, i) => (
          <li key={`${l.sourceBranchId}:${l.targetBlockId ?? i}`}>
            <button className="backlinks-link" onClick={() => onNavigate(l.sourceBranchId)}>
              <span className="backlinks-title">{l.sourceTitle ?? l.sourceSlug}</span>
              {l.targetBlockId && <span className="backlinks-block">§ {l.targetBlockId.slice(0, 12)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
