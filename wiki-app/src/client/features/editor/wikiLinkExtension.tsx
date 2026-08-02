import { Extension } from "@tiptap/core";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { createRoot, type Root } from "react-dom/client";
import { WikiLinkPopup } from "./WikiLinkPopup.js";

interface WikiLinkItem { slug: string; title: string; branchId: string }

/**
 * Triggers `[[page-slug` and shows a searchable popup of wiki pages.
 * Selecting a page inserts a mark link of the form `/wiki/<branchId>`.
 * Uses the same @tiptap/suggestion pattern as SlashCommandExtension.
 */
export const WikiLinkExtension = Extension.create({
  name: "wikiLink",

  addOptions() {
    return {
      suggestion: {
        char: "[[",
        allowSpaces: true,
        pluginKey: "wikiLink",
        command: ({ editor, range, props }: { editor: any; range: any; props: WikiLinkItem }) => {
          editor
            .chain()
            .focus()
            .deleteRange({ from: range.from - 2, to: range.to })
            .insertContent([
              { type: "text", text: props.title, marks: [{ type: "link", attrs: { href: `/wiki/${props.branchId}` } }] },
            ])
            .run();
        },
        items: ({ query }: { query: string }): WikiLinkItem[] => {
          if (!query) return [];
          return []; // populated async by the popup
        },
        render: () => createWikiLinkRenderer(),
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

function createWikiLinkRenderer() {
  let root: Root | null = null;
  let popupEl: HTMLElement | null = null;
  let selectedIndex = 0;
  let items: WikiLinkItem[] = [];
  let currentQuery = "";
  let latestProps: any = null;

  function renderPopup() {
    if (!root) return;
    root.render(
      <WikiLinkPopup
        items={items}
        selectedIndex={selectedIndex}
        query={currentQuery}
        command={(item) => {
          const event = new CustomEvent("wiki-link-pick", { detail: item });
          popupEl?.dispatchEvent(event);
        }}
      />
    );
  }

  return {
    onStart: (props: any) => {
      latestProps = props;
      items = props.items;
      currentQuery = props.query;
      selectedIndex = 0;
      popupEl = document.createElement("div");
      popupEl.style.position = "absolute";
      popupEl.style.zIndex = "999";
      document.body.appendChild(popupEl);

      const rect = props.clientRect?.();
      if (rect) {
        popupEl.style.left = `${window.scrollX + rect.left}px`;
        popupEl.style.top = `${window.scrollY + rect.bottom + 4}px`;
      }

      root = createRoot(popupEl);
      popupEl.addEventListener("wiki-link-pick", ((e: CustomEvent) => {
        latestProps?.command(e.detail);
      }) as EventListener);

      renderPopup();
    },

    onUpdate: (props: any) => {
      latestProps = props;
      currentQuery = props.query;
      selectedIndex = 0;
      renderPopup();
    },

    onKeyDown: (props: any) => {
      if (props.event.key === "ArrowDown") {
        selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
        renderPopup();
        return true;
      }
      if (props.event.key === "ArrowUp") {
        selectedIndex = Math.max(selectedIndex - 1, 0);
        renderPopup();
        return true;
      }
      if (props.event.key === "Enter") {
        if (items[selectedIndex]) {
          props.command(items[selectedIndex]);
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
      if (root) { root.unmount(); root = null; }
      if (popupEl) { popupEl.remove(); popupEl = null; }
      items = [];
    },
  };
}
