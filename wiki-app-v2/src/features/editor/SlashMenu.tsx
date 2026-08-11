import { useEffect, useState, useCallback, type KeyboardEvent } from "react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { useSlashCommands } from "@/plugins/registry";

// ---------------------------------------------------------------------------
// Slash menu — shows a filtered suggestion list when the user types "/" at
// the start of a line or after whitespace. Registered commands come from the
// plugin registry (core can also register commands via the same flow).
// ---------------------------------------------------------------------------

interface SlashState {
  open: boolean;
  query: string;
  range: { from: number; to: number };
}

const slashKey = new PluginKey<SlashState>("slashMenu");

export const SlashMenuExtension = Extension.create({
  name: "slashMenu",

  addProseMirrorPlugins() {
    const plugin = new Plugin<SlashState>({
      key: slashKey,
      state: {
        init: () => ({ open: false, query: "", range: { from: 0, to: 0 } }),
        apply(tr, prev) {
          // Close on any meta reset or selection change that invalidates.
          if (tr.getMeta(slashKey) === "close") return { open: false, query: "", range: { from: 0, to: 0 } };
          return prev;
        },
      },
      props: {
        handleTextInput(view, from, _to, text) {
          if (text === "/") {
            const $pos = view.state.doc.resolve(from);
            const textBefore = $pos.parent.textContent.slice(0, $pos.parentOffset);
            // Only open at line start or after whitespace
            if (textBefore.length === 0 || /\s$/.test(textBefore)) {
              view.dispatch(view.state.tr.setMeta(slashKey, { open: true, query: "", range: { from: from + 1, to: from + 1 } }));
            }
            return false;
          }
          return false;
        },
        handleKeyDown(view, _event) {
          const state = slashKey.getState(view.state);
          if (!state?.open) return false;
          return false; // handled by React component
        },
      },
    });
    return [plugin];
  },
});

// ---------------------------------------------------------------------------
// React component — rendered below the editor via a portal or as a sibling.
// Reads slash state from the plugin key and renders a filtered menu.
// ---------------------------------------------------------------------------

export function SlashMenu({ editor }: { editor: import("@tiptap/core").Editor }) {
  const commands = useSlashCommands();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [fromPos, setFromPos] = useState(0);

  // Watch for slash plugin state changes via transactions
  useEffect(() => {
    const handler = () => {
      const state = slashKey.getState(editor.state) as SlashState | undefined;
      if (state?.open && !open) {
        // Find position for the menu
        const { from } = state.range;
        const coords = editor.view.coordsAtPos(from);
        const editorEl = editor.view.dom.getBoundingClientRect();
        setCoords({ x: coords.left - editorEl.left, y: coords.bottom - editorEl.top + 4 });
        setFromPos(from);
        setQuery("");
        setSelectedIdx(0);
        setOpen(true);
      } else if (!state?.open && open) {
        setOpen(false);
      }
    };
    editor.on("transaction", handler);
    // Also listen to selection update (key shortcut close)
    editor.on("selectionUpdate", () => {
      const state = slashKey.getState(editor.state) as SlashState | undefined;
      if (!state?.open) setOpen(false);
    });
    return () => { editor.off("transaction", handler); };
  }, [editor, open]);

  // Filter commands by query
  const filtered = commands.filter(c => {
    const q = query.toLowerCase();
    return c.label.toLowerCase().includes(q) || c.keywords?.some(k => k.toLowerCase().includes(q));
  });

  // Clamp selected index
  const safeIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1));

  // If query text is typed after "/", update via input event
  useEffect(() => {
    if (!open) return;
    const handleInput = () => {
      const doc = editor.state.doc;
      const text = doc.textBetween(fromPos + 1, editor.state.selection.from, " ");
      setQuery(text);
    };
    editor.on("update", handleInput);
    return () => { editor.off("update", handleInput); };
  }, [editor, open, fromPos]);

  const run = useCallback((idx: number) => {
    const cmd = filtered[idx];
    if (!cmd) return;
    setOpen(false);
    // Delete the "/query" text
    editor.chain().focus().deleteRange({ from: fromPos, to: editor.state.selection.from }).run();
    cmd.run(editor);
  }, [editor, filtered, fromPos]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(safeIdx); }
    else if (e.key === "Escape") { setOpen(false); editor.chain().focus().run(); }
  }, [filtered.length, safeIdx, run, editor]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const clickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-slash-menu]")) return;
      setOpen(false);
      editor.chain().focus().run();
    };
    document.addEventListener("mousedown", clickHandler);
    return () => document.removeEventListener("mousedown", clickHandler);
  }, [open, editor]);

  if (!open || !coords) return null;

  return (
    <div
      data-slash-menu
      className="absolute z-50 w-56 rounded-lg border border-border bg-surface-elevated shadow-lg py-1"
      style={{ left: coords.x, top: coords.y }}
      onKeyDown={handleKeyDown}
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
            onMouseEnter={() => setSelectedIdx(i)}
            onClick={() => run(i)}
          >
            {cmd.icon && <span className="w-5 text-center text-xs">{cmd.icon}</span>}
            <span>{cmd.label}</span>
          </button>
        ))
      )}
    </div>
  );
}
