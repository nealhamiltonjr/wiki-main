import { Extension } from "@tiptap/core";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "prosemirror-state";
import { api } from "../../api/client.js";

interface WikiLinkItem { slug: string; title: string; branchId: string }

/**
 * Triggers `[[page-slug` and shows a searchable popup of wiki pages.
 * Selecting a page inserts a mark link of the form `/wiki/<branchId>`.
 * Uses plain-DOM rendering (no React) to avoid ProseMirror bundle conflicts
 * in Vite production builds.
 */
export const WikiLinkExtension = Extension.create({
  name: "wikiLink",

  addOptions() {
    return {
      suggestion: {
        char: "[[",
        allowSpaces: true,
        pluginKey: new PluginKey("wikiLink"),
        command: ({ editor, range, props }: { editor: any; range: any; props: WikiLinkItem }) => {
          // v3 suggestion `range` ALREADY includes the "[[" trigger chars, so
          // deleting from range.from (not range.from - 2) removes exactly the
          // "[[query" text. The old -2 ate two chars before the trigger
          // ("Hello [[wiki" → "Hell…") and crashed with "Position -1 out of
          // range" when the trigger sat at position 0.
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              { type: "text", text: props.title, marks: [{ type: "link", attrs: { href: `/wiki/${props.branchId}` } }] },
            ])
            .run();
        },
        items: ({ query }: { query: string }): WikiLinkItem[] => {
          if (!query) return [];
          return []; // populated async by the popup
        },
        render: () => createDomRenderer(),
      } as unknown as Partial<SuggestionOptions<WikiLinkItem>>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      } as SuggestionOptions<WikiLinkItem>),
    ];
  },
});

function createDomRenderer() {
  let popupEl: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let selectedIndex = 0;
  let items: WikiLinkItem[] = [];
  let latestProps: any = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (items.length === 0) {
      listEl.innerHTML = '<div class="suggestion-empty">No pages found</div>';
      return;
    }
    items.forEach((item, i) => {
      const btn = document.createElement("button");
      btn.className = `suggestion-item${i === selectedIndex ? " selected" : ""}`;
      btn.innerHTML = `<span class="suggestion-title">${escapeHtml(item.title)}</span><span class="suggestion-slug">${escapeHtml(item.slug)}</span>`;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        latestProps?.command(item);
      });
      listEl!.appendChild(btn);
    });
  }

  function doSearch(query: string) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        const data = await api.search(query);
        items = (data.results as any[]).map((x: any) => ({
          slug: x.slug,
          title: x.title || x.slug.replace(/-/g, " "),
          branchId: x.branchId,
        }));
      } catch {
        items = [];
      }
      if (items.length === 0) {
        items = [{ slug: query, title: query, branchId: "" }];
      }
      renderList();
    }, 150);
  }

  return {
    onStart: (props: any) => {
      latestProps = props;
      items = [];
      selectedIndex = 0;

      popupEl = document.createElement("div");
      popupEl.className = "suggestion-list";
      popupEl.style.position = "absolute";
      popupEl.style.zIndex = "999";
      popupEl.style.background = "var(--color-surface)";
      popupEl.style.border = "1px solid var(--color-border)";
      popupEl.style.borderRadius = "6px";
      popupEl.style.padding = "4px";
      popupEl.style.minWidth = "240px";
      popupEl.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";

      // No search <input> here: it previously autofocused and stole the
      // arrow/Enter keys away from the suggestion menu, so keyboard selection
      // was impossible. The query is typed in the editor itself and the
      // suggestion plugin calls onUpdate, which drives the search.
      listEl = document.createElement("div");
      popupEl.appendChild(listEl);

      const rect = props.clientRect?.();
      if (rect) {
        popupEl.style.left = `${window.scrollX + rect.left}px`;
        popupEl.style.top = `${window.scrollY + rect.bottom + 4}px`;
      }

      document.body.appendChild(popupEl);

      if (props.query) doSearch(props.query);
      else renderList();
    },

    onUpdate: (props: any) => {
      latestProps = props;
      selectedIndex = 0;
      if (props.query) doSearch(props.query);
    },

    onKeyDown: (props: any) => {
      if (props.event.key === "ArrowDown") {
        selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
        renderList();
        return true;
      }
      if (props.event.key === "ArrowUp") {
        selectedIndex = Math.max(selectedIndex - 1, 0);
        renderList();
        return true;
      }
      if (props.event.key === "Enter") {
        if (items[selectedIndex]) {
          // @tiptap/suggestion v3 does NOT pass `command` into onKeyDown —
          // only { view, event, range }. Use the command bound to the CURRENT
          // range from the latest props.
          latestProps?.command(items[selectedIndex]);
          return true;
        }
      }
      if (props.event.key === "Escape") {
        return true;
      }
      return false;
    },

    onExit: () => {
      latestProps = null;
      if (searchTimer) clearTimeout(searchTimer);
      if (popupEl) { popupEl.remove(); popupEl = null; }
      listEl = null;
      items = [];
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
