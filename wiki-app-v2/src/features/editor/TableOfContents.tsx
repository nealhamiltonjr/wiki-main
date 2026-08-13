import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

// §12.6 — In-page table of contents.
//
// Auto-generated from a Tiptap doc's top-level heading nodes. Renders a
// sticky right-rail nav with depth-aware indentation, smooth-scroll click
// handlers, and an IntersectionObserver scroll-spy that highlights the
// heading currently in the viewport.
//
// Extracted from src/routes/_authenticated/w/$branchId.tsx in slice-19 so
// it can be unit-tested in isolation and reused by other read views
// (share-link render, future printable export, etc).

export interface TocEntry {
  id: string;
  level: number;
  text: string;
}

/** Pure helper — extracts top-level heading nodes from a Tiptap JSON doc.
 *  Nested headings (e.g. inside a list item) are intentionally skipped so
 *  the TOC is a flat, navigable outline of the page's section structure.
 *  Returns entries in document order, which is also the visual order. */
export function extractTocEntries(content: unknown): TocEntry[] {
  const entries: TocEntry[] = [];
  const doc = content as { type: string; content?: Array<Record<string, unknown>> } | null;
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return entries;
  for (const node of doc.content) {
    if (node.type === "heading") {
      const attrs = node.attrs as Record<string, unknown> | undefined;
      const id = attrs?.id as string | undefined;
      const level = (attrs?.level as number | undefined) ?? 2;
      const text = extractText(node);
      if (id && text) entries.push({ id, level, text });
    }
  }
  return entries;
}

function extractText(node: Record<string, unknown>): string {
  const children = node.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(children)) return "";
  return children.map((c) => (c.type === "text" ? (c.text as string) ?? "" : "")).join("");
}

/** Walks up from `el` until it finds an ancestor whose overflow allows
 *  scrolling (or the document root). Returns null when the element is
 *  effectively page-level (i.e. the window is the right scroll target).
 *  Used by the TOC click handler to scroll the right container — the
 *  page view (§6.3) mounts ReadOnlyContent inside an `overflow-auto`
 *  flex child, so `window.scrollTo` would be a no-op there. */
function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur && cur !== document.body) {
    const style = window.getComputedStyle(cur);
    const overflowY = style.overflowY;
    const isScrollable =
      (overflowY === "auto" || overflowY === "scroll") && cur.scrollHeight > cur.clientHeight;
    if (isScrollable) return cur;
    cur = cur.parentElement;
  }
  return null;
}

interface TableOfContentsProps {
  /** Tiptap doc JSON. */
  content: unknown;
  /** Minimum number of headings required to render. Default 2. */
  minEntries?: number;
}

/** Sticky right-rail nav. Renders nothing when the doc has fewer than
 *  `minEntries` headings (a 1-heading TOC is just noise). */
export function TableOfContents({ content, minEntries = 2 }: TableOfContentsProps) {
  const entries = useMemo(() => extractTocEntries(content), [content]);
  const [activeId, setActiveId] = useState<string | null>(entries[0]?.id ?? null);

  // Scroll-spy: as the user scrolls, highlight the heading whose section
  // is currently in view. The page view (§6.3) puts the content in a
  // scrollable flex child, so we observe against the nearest scrollable
  // ancestor instead of the viewport. rootMargin biases the trigger zone
  // toward the upper third of the visible area (matches the
  // Notion/Confluence/GitBook convention).
  useEffect(() => {
    if (entries.length < 2) return;
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;

    const elements = entries
      .map((e) => document.getElementById(e.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    // Use the first heading to discover the scroll container — every
    // heading lives in the same scroll root, so one sample is enough.
    const scrollRoot = findScrollableAncestor(elements[0]!);

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (r.isIntersecting) visible.add(r.target.id);
          else visible.delete(r.target.id);
        }
        const next = entries.find((e) => visible.has(e.id));
        if (next) setActiveId(next.id);
      },
      {
        root: scrollRoot ?? undefined,
        rootMargin: "-15% 0% -70% 0%",
        threshold: 0,
      }
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [entries]);

  if (entries.length < minEntries) return null;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const target = document.getElementById(id);
    if (!target) return;
    // The page view (§6.3) renders content inside a scrollable flex child,
    // not at the document root, so we must scroll the nearest scrollable
    // ancestor — not the window. Falling back to the window if the
    // heading is at the document level keeps the TOC useful in any
    // future read view that mounts it at the document root (e.g.
    // share-link render).
    const scrollRoot = findScrollableAncestor(target);
    const offset = 64; // leave room above the heading for sticky chrome
    if (scrollRoot) {
      const top = target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top + scrollRoot.scrollTop - offset;
      scrollRoot.scrollTo({ top, behavior: "smooth" });
    } else {
      const top = target.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: "smooth" });
    }
    if (typeof window.history !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
    }
    setActiveId(id);
  };

  return (
    <nav
      className="sticky top-0 hidden w-52 shrink-0 overflow-auto border-l border-border px-3 py-6 lg:block"
      aria-label="In-page table of contents"
      data-testid="page-toc"
    >
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
        On this page
      </h4>
      <ul className="space-y-0.5">
        {entries.map((e) => {
          const isActive = activeId === e.id;
          return (
            <li key={e.id}>
              <a
                href={`#${e.id}`}
                onClick={(ev) => handleClick(ev, e.id)}
                aria-current={isActive ? "location" : undefined}
                className={cn(
                  "block rounded-sm py-0.5 text-xs transition-colors",
                  isActive
                    ? "bg-bg-subtle font-medium text-foreground"
                    : "text-text-secondary hover:text-foreground",
                  // h1 sits at the top of the page; emphasise a bit
                  // even when not active.
                  e.level === 1 && !isActive && "font-medium",
                  // Deeper headings indent further so the outline
                  // reads as a hierarchy.
                  e.level === 3 && "pl-3",
                  e.level === 4 && "pl-6",
                  e.level >= 5 && "pl-9"
                )}
              >
                {e.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}