import { useEffect, useState, useRef, useCallback } from "react";
import { useWikiSearch, useWikiSearchNavigation, type SearchItem } from "./useWikiSearch.js";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { query, setQuery, pages, spaces, loading, items, selectedIdx, setSelectedIdx, reset } = useWikiSearch();
  const { navigateToSpace, openPage } = useWikiSearchNavigation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(v => !v);
        reset();
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [reset]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const activate = useCallback((item: SearchItem) => {
    if (item.kind === "space") {
      setOpen(false);
      void navigateToSpace(item.id);
    } else {
      setOpen(false);
      openPage(item.branchId);
    }
  }, [navigateToSpace, openPage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, items.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && items[selectedIdx]) activate(items[selectedIdx]!);
    if (e.key === "Escape") setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="cmd-overlay" onClick={() => setOpen(false)}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-input"
          placeholder='Search the wiki… try "linux code", linux OR bsd, or -deprecated'
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="cmd-results">
          {loading && <div className="cmd-status">Searching…</div>}
          {!loading && query && items.length === 0 && <div className="cmd-status">No results</div>}
          {!loading && query && items.length > 0 && (
            <div className="cmd-status">{items.length} result{items.length === 1 ? "" : "s"}</div>
          )}
          {spaces.length > 0 && (
            <>
              <div className="cmd-section">Spaces</div>
              {spaces.map((s, i) => (
                <button
                  key={s.id}
                  className={`cmd-item${i === selectedIdx ? " selected" : ""}`}
                  onClick={() => activate({ kind: "space", id: s.id, name: s.name, pageCount: s.pageCount })}
                  onMouseEnter={() => setSelectedIdx(i)}
                >
                  <span className="cmd-title">{s.name}</span>
                  <span className="cmd-slug">space · {s.pageCount} page{s.pageCount === 1 ? "" : "s"}</span>
                </button>
              ))}
            </>
          )}
          {pages.length > 0 && (
            <>
              <div className="cmd-section">Pages</div>
              {pages.map((r, i) => {
                const idx = spaces.length + i;
                return (
                  <button
                    key={r.branchId}
                    className={`cmd-item${idx === selectedIdx ? " selected" : ""}`}
                    onClick={() => activate({ kind: "page", branchId: r.branchId, title: r.title, slug: r.slug, snippet: r.snippet, spaceName: r.spaceName })}
                    onMouseEnter={() => setSelectedIdx(idx)}
                  >
                    <span className="cmd-title">{r.title || r.slug}</span>
                    <span className="cmd-slug">{r.spaceName ? `/${r.spaceName}/` : "/"}{r.slug}</span>
                    <span className="cmd-snippet" dangerouslySetInnerHTML={{ __html: r.snippet }} />
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
