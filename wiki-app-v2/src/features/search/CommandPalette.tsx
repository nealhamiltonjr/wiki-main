import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api, type PageSearchHit } from "@/api/client";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PageSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setOpen((v) => !v); setQuery(""); setResults([]); setSelectedIdx(0); }
      if (e.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  useEffect(() => { if (open) { const t = setTimeout(() => inputRef.current?.focus(), 30); return () => clearTimeout(t); } }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const t = setTimeout(() => { api.searchPages(q, { limit: 20 }).then((res) => { setResults(res.results); setSelectedIdx(0); }).catch(() => setResults([])).finally(() => setLoading(false)); }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const grouped = useMemo(() => {
    const map = new Map<string, { spaceName: string; hits: PageSearchHit[] }>();
    for (const r of results) { let g = map.get(r.spaceId); if (!g) { g = { spaceName: r.spaceName, hits: [] }; map.set(r.spaceId, g); } g.hits.push(r); }
    return Array.from(map.entries());
  }, [results]);
  const flatResults = useMemo(() => grouped.flatMap(([, g]) => g.hits), [grouped]);

  const activate = useCallback((hit: PageSearchHit) => { setOpen(false); void navigate({ to: "/w/$branchId", params: { branchId: hit.branchId } }); }, [navigate]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, flatResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && flatResults[selectedIdx]) { e.preventDefault(); activate(flatResults[selectedIdx]!); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  if (!open) return null;
  let runningIdx = 0;
  return (
    <div className="cmd-overlay" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Search the wiki">
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="cmd-input" placeholder='Search pages…' value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} aria-label="Search query" type="search" autoComplete="off" spellCheck={false} />
        <div className="cmd-results">
          {loading && <div className="cmd-status">Searching…</div>}
          {!loading && query.trim().length >= 2 && results.length === 0 && <div className="cmd-status">No results for "{query.trim()}".</div>}
          {!loading && query.trim().length < 2 && <div className="cmd-status">Type at least 2 characters to search.</div>}
          {!loading && results.length > 0 && <div className="cmd-status">{results.length} result{results.length === 1 ? "" : "s"}</div>}
          {!loading && grouped.map(([spaceId, group]) => {
            const groupStart = runningIdx; runningIdx += group.hits.length;
            return (
              <div key={spaceId} className="cmd-group">
                <div className="cmd-section">{group.spaceName}</div>
                {group.hits.map((hit, i) => { const flatIdx = groupStart + i; const selected = flatIdx === selectedIdx; return (
                  <button key={hit.branchId} className={`cmd-item${selected ? " selected" : ""}`} onClick={() => activate(hit)} onMouseEnter={() => setSelectedIdx(flatIdx)} role="option" aria-selected={selected}>
                    <div className="cmd-item-title">{hit.title || hit.slug}</div>
                    {hit.snippet && <div className="cmd-item-snippet" dangerouslySetInnerHTML={{ __html: hit.snippet }} />}
                  </button>
                ); })}
              </div>
            );
          })}
        </div>
        <div className="cmd-footer"><kbd>↑</kbd> <kbd>↓</kbd> navigate · <kbd>↵</kbd> open · <kbd>esc</kbd> close</div>
      </div>
    </div>
  );
}
