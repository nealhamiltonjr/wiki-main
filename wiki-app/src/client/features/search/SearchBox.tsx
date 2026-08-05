import { useEffect, useRef, useState } from "react";
import { SearchX } from "lucide-react";
import { useWikiSearch, useWikiSearchNavigation, type SearchItem } from "./useWikiSearch.js";
import { EmptyState } from "../../components/EmptyState.js";

/**
 * Always-visible search bar in the main panel. Types ahead against
 * /api/search and shows a dropdown grouped into Spaces + Pages; Enter/click
 * navigates (page → /pages/:branchId, space → its first page).
 */
export function SearchBox() {
  const { query, setQuery, pages, spaces, loading, items, selectedIdx, setSelectedIdx } = useWikiSearch();
  const { navigateToSpace, openPage } = useWikiSearchNavigation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const activate = (item: SearchItem) => {
    setOpen(false);
    if (item.kind === "space") void navigateToSpace(item.id);
    else openPage(item.branchId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, items.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && items[selectedIdx]) activate(items[selectedIdx]!);
    if (e.key === "Escape") setOpen(false);
  };

  const showDropdown = open && query.trim() !== "";

  return (
    <div className="main-search" ref={rootRef}>
      <div className="main-search-bar">
        <span className="main-search-icon" aria-hidden>🔍</span>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search pages and spaces…"
          aria-label="Search pages and spaces"
        />
        {loading && <span className="main-search-spinner" aria-hidden />}
      </div>
      {showDropdown && (
        <div className="main-search-dropdown">
          {loading && <div className="cmd-status">Searching…</div>}
          {!loading && items.length === 0 && (
            <EmptyState
              compact
              icon={SearchX}
              title={`No results for “${query}”`}
              description="Try a different search term."
            />
          )}
          {!loading && items.length > 0 && (
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
      )}
    </div>
  );
}
