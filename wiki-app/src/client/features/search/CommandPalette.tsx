import { useEffect, useState, useRef, useCallback } from "react";

interface SearchResult {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  snippet: string;
  spaceId: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(v => !v);
        setQuery("");
        setResults([]);
        setSelectedIdx(0);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { credentials: "include", signal: ac.signal })
        .then(r => r.json())
        .then(d => { setResults((d.results ?? []).slice(0, 10)); setSelectedIdx(0); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 200);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [query]);

  const navigate = useCallback((branchId: string) => {
    setOpen(false);
    window.location.hash = `#/wiki/${branchId}`;
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, results.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && results[selectedIdx]) { navigate(results[selectedIdx]!.branchId); }
    if (e.key === "Escape") setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="cmd-overlay" onClick={() => setOpen(false)}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-input"
          placeholder="Search pages…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="cmd-results">
          {loading && <div className="cmd-status">Searching…</div>}
          {!loading && query && results.length === 0 && <div className="cmd-status">No results</div>}
          {results.map((r, i) => (
            <button
              key={r.branchId}
              className={`cmd-item${i === selectedIdx ? " selected" : ""}`}
              onClick={() => navigate(r.branchId)}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <span className="cmd-title">{r.title || r.slug}</span>
              <span className="cmd-slug">/{r.slug}</span>
              <span className="cmd-snippet" dangerouslySetInnerHTML={{ __html: r.snippet }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
