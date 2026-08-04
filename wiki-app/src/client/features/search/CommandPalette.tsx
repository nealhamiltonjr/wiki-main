import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client.js";

interface PageResult {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  snippet: string;
  spaceId: string;
  spaceName: string;
}

interface SpaceResult {
  id: string;
  name: string;
  pageCount: number;
}

type Item =
  | { kind: "space"; id: string; name: string; pageCount: number }
  | { kind: "page"; branchId: string; title: string; slug: string; snippet: string; spaceName: string };

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<PageResult[]>([]);
  const [spaces, setSpaces] = useState<SpaceResult[]>([]);
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
        setPages([]);
        setSpaces([]);
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
    if (!query.trim()) { setPages([]); setSpaces([]); return; }
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { credentials: "include", signal: ac.signal })
        .then(r => r.json())
        .then(d => {
          setSpaces((d.spaces ?? []).slice(0, 5));
          setPages((d.results ?? []).slice(0, 10));
          setSelectedIdx(0);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 200);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [query]);

  // Combined list: spaces first, then pages — drives arrow-key navigation.
  const items: Item[] = [
    ...spaces.map(s => ({ kind: "space", id: s.id, name: s.name, pageCount: s.pageCount }) as Item),
    ...pages.map(p => ({ kind: "page", branchId: p.branchId, title: p.title, slug: p.slug, snippet: p.snippet, spaceName: p.spaceName }) as Item),
  ];

  const navigateToSpace = useCallback(async (spaceId: string) => {
    setOpen(false);
    try {
      const tree = await api.getSpaceTree(spaceId);
      const stack = [...tree];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.id) { navigate(`/pages/${node.id}`); return; }
        stack.push(...node.children);
      }
      navigate("/");
    } catch {
      navigate("/");
    }
  }, [navigate]);

  const activate = useCallback((item: Item) => {
    if (item.kind === "space") navigateToSpace(item.id);
    else { setOpen(false); navigate(`/pages/${item.branchId}`); }
  }, [navigate, navigateToSpace]);

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
          placeholder="Search spaces and pages…"
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
