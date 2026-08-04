import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client.js";

export interface PageResult {
  pageId: string;
  branchId: string;
  slug: string;
  title: string;
  snippet: string;
  spaceId: string;
  spaceName: string;
}

export interface SpaceResult {
  id: string;
  name: string;
  pageCount: number;
}

export type SearchItem =
  | { kind: "space"; id: string; name: string; pageCount: number }
  | { kind: "page"; branchId: string; title: string; slug: string; snippet: string; spaceName: string };

/**
 * Shared search state for both the Cmd+K palette and the main-panel search box.
 * Debounced fetch against /api/search (pages + spaces) with abort-on-new-query.
 */
export function useWikiSearch(delay = 200, maxSpaces = 5, maxPages = 10) {
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<PageResult[]>([]);
  const [spaces, setSpaces] = useState<SpaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setQuery("");
    setPages([]);
    setSpaces([]);
    setSelectedIdx(0);
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setPages([]);
      setSpaces([]);
      setLoading(false);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}&limit=30`, { credentials: "include", signal: ac.signal })
        .then((r) => r.json())
        .then((d) => {
          setSpaces((d.spaces ?? []).slice(0, maxSpaces));
          setPages((d.results ?? []).slice(0, maxPages));
          setSelectedIdx(0);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, delay);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [query, delay, maxSpaces, maxPages]);

  // Combined list: spaces first, then pages — drives arrow-key navigation.
  const items: SearchItem[] = [
    ...spaces.map((s) => ({ kind: "space", id: s.id, name: s.name, pageCount: s.pageCount }) as SearchItem),
    ...pages.map((p) => ({ kind: "page", branchId: p.branchId, title: p.title, slug: p.slug, snippet: p.snippet, spaceName: p.spaceName }) as SearchItem),
  ];

  return { query, setQuery, pages, spaces, loading, items, selectedIdx, setSelectedIdx, reset };
}

/**
 * Navigation helpers for search results: open a page branch, or open the first
 * page of a space. Shared so the palette and the main-panel box behave alike.
 */
export function useWikiSearchNavigation() {
  const navigate = useNavigate();

  const navigateToSpace = useCallback(
    async (spaceId: string): Promise<void> => {
      try {
        const tree = await api.getSpaceTree(spaceId);
        const stack = [...tree];
        while (stack.length > 0) {
          const node = stack.pop()!;
          if (node.id) {
            navigate(`/pages/${node.id}`);
            return;
          }
          stack.push(...node.children);
        }
        navigate("/");
      } catch {
        navigate("/");
      }
    },
    [navigate],
  );

  const openPage = useCallback((branchId: string) => navigate(`/pages/${branchId}`), [navigate]);

  return { navigateToSpace, openPage };
}
