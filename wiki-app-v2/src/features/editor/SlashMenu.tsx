import { useCallback, useEffect, useState } from "react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { useSlashCommands } from "@/plugins/registry";

// ---------------------------------------------------------------------------
// Slash menu — a ProseMirror plugin owned state machine + React popover.
//
// The plugin detects "/" typed at line-start/after-whitespace, tracks the
// query text as the user types, and intercepts Arrow/Enter/Escape while open.
// The React component below renders the filtered command list and executes the
// selected command. Commands come from the plugin registry (§4.4 slashCommands).
// ---------------------------------------------------------------------------

interface SlashState {
  open: boolean;
  query: string;
  range: { from: number; to: number };
  selected: number;
  /** Set when the user pressed Enter — the component runs the command and closes. */
  run: boolean;
}

type SlashMeta =
  | { type: "open"; range: { from: number; to: number } }
  | { type: "nav"; delta: 1 | -1 }
  | { type: "select"; index: number }
  | { type: "run" }
  | "close";

const closedState: SlashState = { open: false, query: "", range: { from: 0, to: 0 }, selected: 0, run: false };
const slashKey = new PluginKey<SlashState>("slashMenu");

const SLASH_MAX_ITEMS = 64;

export const SlashMenuExtension = Extension.create({
  name: "slashMenu",

  addProseMirrorPlugins() {
    const plugin = new Plugin<SlashState>({
      key: slashKey,
      state: {
        init: () => closedState,
        apply(tr, prev) {
          const meta = tr.getMeta(slashKey) as SlashMeta | undefined;
          if (meta === "close") return closedState;
          if (meta && typeof meta === "object") {
            if (meta.type === "open") return { ...closedState, open: true, range: meta.range };
            if (meta.type === "nav") {
              return { ...prev, selected: Math.max(0, Math.min(prev.selected + meta.delta, SLASH_MAX_ITEMS)) };
            }
            if (meta.type === "select") return { ...prev, selected: Math.max(0, meta.index) };
            if (meta.type === "run") return { ...prev, run: true };
          }
          // While open, live-track the query as the user types/deletes.
          if (prev.open && tr.docChanged) {
            const from = prev.range.from;
            const to = tr.selection.from;
            const query = to > from ? tr.doc.textBetween(from, to, " ") : "";
            return { ...prev, query };
          }
          return prev;
        },
      },
      props: {
        handleTextInput(view, from, _to, text) {
          if (text !== "/") return false;
          const $pos = view.state.doc.resolve(from);
          const textBefore = $pos.parent.textContent.slice(0, $pos.parentOffset);
          // Only open at line start or after whitespace.
          if (textBefore.length !== 0 && !/\s$/.test(textBefore)) return false;
          view.dispatch(
            view.state.tr.setMeta(slashKey, { type: "open", range: { from: from + 1, to: from + 1 } } satisfies SlashMeta)
          );
          return false;
        },
        handleKeyDown(view, event) {
          const state = slashKey.getState(view.state);
          if (!state?.open) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            view.dispatch(view.state.tr.setMeta(slashKey, { type: "nav", delta: event.key === "ArrowDown" ? 1 : -1 } satisfies SlashMeta));
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            view.dispatch(view.state.tr.setMeta(slashKey, { type: "run" } satisfies SlashMeta));
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            view.dispatch(view.state.tr.setMeta(slashKey, "close"));
            return true;
          }
          return false;
        },
      },
    });
    return [plugin];
  },
});

export function SlashMenu({ editor }: { editor: import("@tiptap/core").Editor }) {
  const commands = useSlashCommands();
  const [state, setState] = useState<SlashState>(closedState);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);

  // Mirror the plugin state into React state on every transaction.
  useEffect(() => {
    const sync = () => {
      const st = slashKey.getState(editor.state);
      if (!st) return;
      if (st.open) {
        const at = editor.view.coordsAtPos(st.range.from);
        const editorEl = editor.view.dom.getBoundingClientRect();
        setCoords({ x: at.left - editorEl.left, y: at.bottom - editorEl.top + 4 });
      }
      setState(st);
    };
    editor.on("transaction", sync);
    editor.on("selectionUpdate", sync);
    return () => {
      editor.off("transaction", sync);
      editor.off("selectionUpdate", sync);
    };
  }, [editor]);

  const filtered = commands.filter((c) => {
    const q = state.query.toLowerCase();
    return c.label.toLowerCase().includes(q) || c.keywords?.some((k) => k.toLowerCase().includes(q));
  });
  const safeIdx = Math.min(state.selected, Math.max(0, filtered.length - 1));

  const close = useCallback(() => {
    editor.view.dispatch(editor.state.tr.setMeta(slashKey, "close"));
    setCoords(null);
  }, [editor]);

  const execute = useCallback((idx: number) => {
    const cmd = filtered[idx];
    if (!cmd) return;
    const st = slashKey.getState(editor.state);
    // Delete "/" + the typed query before running the command.
    const from = st?.range.from ? st.range.from - 1 : editor.state.selection.from;
    editor.chain().focus().deleteRange({ from, to: editor.state.selection.from }).run();
    try {
      cmd.run(editor);
    } finally {
      close();
    }
  }, [editor, filtered, close]);

  // When the plugin state signals Enter (run), execute the selected command.
  useEffect(() => {
    if (!state.open || !state.run) return;
    execute(safeIdx);
  }, [state, safeIdx, execute]);

  // Close on outside click.
  useEffect(() => {
    if (!state.open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-slash-menu]")) return;
      close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [state.open, close]);

  if (!state.open || !coords) return null;

  return (
    <div
      data-slash-menu
      className="absolute z-50 w-56 rounded-lg border border-border bg-surface-elevated shadow-lg py-1"
      style={{ left: coords.x, top: coords.y }}
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-xs text-text-muted">No matching commands</div>
      ) : (
        filtered.map((cmd, i) => (
          <button
            key={cmd.name}
            type="button"
            className={[
              "flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left",
              i === safeIdx ? "bg-primary/10 text-primary" : "text-foreground hover:bg-surface-hover",
            ].join(" ")}
            onMouseEnter={() => {
              if (i !== safeIdx) {
                editor.view.dispatch(editor.state.tr.setMeta(slashKey, { type: "select", index: i } satisfies SlashMeta));
              }
            }}
            onClick={() => execute(i)}
          >
            {cmd.icon && <span className="w-5 text-center text-xs">{cmd.icon}</span>}
            <span>{cmd.label}</span>
          </button>
        ))
      )}
    </div>
  );
}
