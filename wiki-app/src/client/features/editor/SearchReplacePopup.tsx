import { useEffect, useRef, useState } from "react";
import type { Editor as TiptapEditor } from "@tiptap/core";

/**
 * Search & replace popover (Phase 2), powered by the vendored
 * @sereneinserenade SearchAndReplace extension (vendor/search-and-replace.ts).
 * Opened from the toolbar or Ctrl/Cmd+F; Esc closes and clears the highlight.
 */

interface Props {
  editor: TiptapEditor;
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 13,
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-text)",
  minWidth: 140,
};

const btnStyle = (active = false): React.CSSProperties => ({
  padding: "4px 8px",
  fontSize: 12,
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: active ? "var(--color-primary)" : "var(--color-surface)",
  color: active ? "var(--color-primary-text)" : "var(--color-text)",
  cursor: "pointer",
});

export function SearchReplacePopup({ editor, onClose }: Props) {
  const [term, setTerm] = useState("");
  const [replaceTerm, setReplaceTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus the search box on open.
  useEffect(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  const refreshCount = () => {
    const storage = editor.storage.searchAndReplace;
    setCount(storage.results?.length ?? 0);
    setCurrent((storage.resultIndex ?? 0) + 1);
  };

  const applySearch = (next: string) => {
    setTerm(next);
    editor.commands.setSearchTerm(next);
    refreshCount();
  };

  const applyReplaceTerm = (next: string) => {
    setReplaceTerm(next);
    editor.commands.setReplaceTerm(next);
  };

  const toggleCase = () => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    editor.commands.setCaseSensitive(next);
    refreshCount();
  };

  const nextResult = () => {
    editor.commands.nextSearchResult();
    refreshCount();
  };

  const prevResult = () => {
    editor.commands.previousSearchResult();
    refreshCount();
  };

  const replace = () => {
    editor.commands.replace();
    refreshCount();
  };

  const replaceAll = () => {
    editor.commands.replaceAll();
    refreshCount();
  };

  const close = () => {
    // Clearing = setting an empty search term (the plugin drops its
    // decorations when the term is empty).
    editor.commands.setSearchTerm("");
    editor.commands.focus();
    onClose();
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        background: "var(--color-surface)",
        boxShadow: "var(--shadow-md)",
        flexWrap: "wrap",
        fontSize: 13,
      }}
    >
      <input
        ref={searchRef}
        value={term}
        onChange={(e) => applySearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.shiftKey ? prevResult : nextResult)();
          if (e.key === "Escape") close();
        }}
        placeholder="Find…"
        style={inputStyle}
      />
      <span style={{ fontSize: 12, color: "var(--color-text-muted)", minWidth: 40 }}>
        {term ? `${current}/${count}` : ""}
      </span>
      <button type="button" style={btnStyle()} onClick={prevResult} title="Previous (Shift+Enter)">
        ↑
      </button>
      <button type="button" style={btnStyle()} onClick={nextResult} title="Next (Enter)">
        ↓
      </button>
      <button type="button" style={btnStyle(caseSensitive)} onClick={toggleCase} title="Match case">
        Aa
      </button>

      <input
        value={replaceTerm}
        onChange={(e) => applyReplaceTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") replace();
          if (e.key === "Escape") close();
        }}
        placeholder="Replace…"
        style={{ ...inputStyle, minWidth: 120 }}
      />
      <button type="button" style={btnStyle()} onClick={replace} title="Replace current (Enter)">
        Replace
      </button>
      <button type="button" style={btnStyle()} onClick={replaceAll} title="Replace all">
        All
      </button>

      <button type="button" style={btnStyle()} onClick={close} title="Close (Esc)">
        ✕
      </button>
    </div>
  );
}
