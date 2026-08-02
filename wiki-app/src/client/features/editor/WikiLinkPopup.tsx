import { useState, useEffect } from "react";
import { api } from "../../api/client.js";

interface WikiLinkSuggestion { slug: string; title: string; branchId: string }

/**
 * Small popup rendered inside the Tiptap suggestion dropdown for [[page]]
 * internal linking. Shows a search input that queries the search API and
 * renders matching pages. Clicking one inserts a wiki-link mark.
 */
export function WikiLinkPopup({
  items,
  selectedIndex,
  command,
  query,
}: {
  items: WikiLinkSuggestion[];
  selectedIndex: number;
  command: (item: WikiLinkSuggestion) => void;
  query: string;
}) {
  const [results, setResults] = useState<WikiLinkSuggestion[]>(items);

  useEffect(() => {
    if (!query) { setResults(items); return; }
    let cancelled = false;
    const q = query.startsWith("[[") ? query.slice(2) : query;
    api.search(q).then((data) => {
      if (cancelled) return;
      const list: WikiLinkSuggestion[] = (data.results as any[]).map((x: any) => ({
        slug: x.slug,
        title: x.title || x.slug.replace(/-/g, " "),
        branchId: x.branchId,
      }));
      setResults(list.length > 0 ? list : items);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [query, items]);

  if (results.length === 0) {
    return <div className="suggestion-empty">No pages found for &ldquo;{query}&rdquo;</div>;
  }

  return (
    <div className="suggestion-list">
      {results.map((item, i) => (
        <button
          key={item.branchId}
          className={`suggestion-item${i === selectedIndex ? " selected" : ""}`}
          onClick={() => command(item)}
        >
          <span className="suggestion-title">{item.title}</span>
          <span className="suggestion-slug">{item.slug}</span>
        </button>
      ))}
    </div>
  );
}
