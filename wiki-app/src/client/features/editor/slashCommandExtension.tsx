import { Extension } from "@tiptap/core";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { createRoot, type Root } from "react-dom/client";
import { SlashCommandPopup } from "./SlashCommandPopup.js";
import { getSlashCommands } from "./pluginEngine.js";
import type { SlashCommand } from "./pluginEngine.js";

/**
 * Tiptap extension that triggers a slash-command menu when the user types `/`
 * at the start of a line (or after a whitespace). Built on @tiptap/suggestion.
 *
 * The menu items come from the plugin engine's registry — core commands and
 * third-party plugins both register through the same `registerSlashCommand()`
 * call, so this extension is a pure consumer of the registry.
 */
export const SlashCommandExtension = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        command: ({ editor, range, props }: { editor: any; range: any; props: SlashCommand }) => {
          editor.chain().focus().deleteRange(range).run();
          props.command({ editor });
        },
        allow: ({ state }: { state: any }) => {
          const { $from } = state.selection;
          const text = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
          // Allow slash at start of line or after whitespace
          const lastChar = text.slice(-2, -1);
          return lastChar === "" || lastChar === " " || lastChar === "\n";
        },
        items: ({ query }: { query: string }): SlashCommand[] => {
          const all = getSlashCommands();
          if (!query) return all.slice(0, 12);
          const q = query.toLowerCase();
          return all
            .filter((cmd) => cmd.label.toLowerCase().includes(q) || cmd.name.toLowerCase().includes(q))
            .slice(0, 12);
        },
        render: () => createReactRenderer(),
      } as unknown as Partial<SuggestionOptions<SlashCommand>>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      } as SuggestionOptions<SlashCommand>),
    ];
  },
});

// -- React-based renderer for the suggestion popup ---------------------------

function createReactRenderer() {
  let root: Root | null = null;
  let popupEl: HTMLElement | null = null;
  let selectedIndex = 0;
  let items: SlashCommand[] = [];

  function renderPopup() {
    if (!root) return;
    root.render(
      <SlashCommandPopup
        items={items}
        selectedIndex={selectedIndex}
        command={(item) => {
          const event = new CustomEvent("slash-command-pick", { detail: item });
          popupEl?.dispatchEvent(event);
        }}
      />
    );
  }

  return {
    onStart: (props: any) => {
      items = props.items;
      selectedIndex = 0;
      popupEl = document.createElement("div");
      popupEl.style.position = "absolute";
      document.body.appendChild(popupEl);

      const rect = props.clientRect?.();
      if (rect) {
        popupEl.style.left = `${window.scrollX + rect.left}px`;
        popupEl.style.top = `${window.scrollY + rect.bottom + 4}px`;
      }

      root = createRoot(popupEl);

      popupEl.addEventListener("slash-command-pick", ((e: CustomEvent) => {
        props.command(e.detail);
      }) as EventListener);

      renderPopup();
    },

    onUpdate: (props: any) => {
      items = props.items;
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
      if (root) {
        root.unmount();
        root = null;
      }
      if (popupEl) {
        popupEl.remove();
        popupEl = null;
      }
      items = [];
    },
  };
}
