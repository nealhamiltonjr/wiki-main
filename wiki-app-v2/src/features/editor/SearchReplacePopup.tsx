import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { type Editor } from "@tiptap/react";
import { Search, Replace, X, ChevronUp, ChevronDown, CaseSensitive } from "lucide-react";

interface Props { editor: Editor; onClose: () => void; }
interface Match { pos: number; end: number; text: string; }

export function SearchReplacePopup({ editor, onClose }: Props) {
  const [term, setTerm] = useState("");
  const [replaceTerm, setReplaceTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!term) { setMatches([]); setCurrentIdx(0); return; }
    const found = findMatches(editor, term, caseSensitive); setMatches(found); setCurrentIdx(0);
  }, [term, caseSensitive, editor]);

  useEffect(() => {
    if (matches.length === 0) return;
    const m = matches[currentIdx]; if (!m) return;
    editor.commands.setTextSelection({ from: m.pos, to: m.end }); editor.commands.scrollIntoView();
  }, [matches, currentIdx, editor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) setCurrentIdx((i) => (i - 1 + matches.length) % matches.length); else setCurrentIdx((i) => (i + 1) % matches.length); }
  };

  const replaceCurrent = useCallback(() => {
    if (matches.length === 0) return; const m = matches[currentIdx]; if (!m) return;
    editor.chain().focus().insertContentAt({ from: m.pos, to: m.end }, replaceTerm).run();
    setTimeout(() => { const found = findMatches(editor, term, caseSensitive); setMatches(found); setCurrentIdx(Math.min(currentIdx, found.length - 1)); }, 0);
  }, [matches, currentIdx, replaceTerm, editor, term, caseSensitive]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0) return; const sorted = [...matches].sort((a, b) => b.pos - a.pos);
    editor.chain().focus(); for (const m of sorted) { editor.chain().insertContentAt({ from: m.pos, to: m.end }, replaceTerm).run(); }
    setMatches([]); setCurrentIdx(0);
  }, [matches, replaceTerm, editor]);

  return createPortal(
    <div className="cmd-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Find and replace">
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ width: "min(480px, 90vw)" }}>
        <div className="cmd-section" style={{ padding: "0.75rem 1rem 0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Find &amp; replace</span>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-foreground" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div style={{ padding: "0 1rem 1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <Search className="h-4 w-4 text-text-muted flex-shrink-0" />
            <input ref={inputRef} type="text" className="cmd-input" style={{ flex: 1, borderBottom: "1px solid var(--border)" }} placeholder="Find…" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={onKeyDown} aria-label="Find" />
            <button type="button" onClick={() => setCaseSensitive((v) => !v)} className={`flex-shrink-0 rounded p-1 border ${caseSensitive ? "bg-primary text-white border-primary" : "border-border hover:bg-surface"}`} title="Match case" aria-label="Match case" aria-pressed={caseSensitive}><CaseSensitive className="h-4 w-4" /></button>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <Replace className="h-4 w-4 text-text-muted flex-shrink-0" />
            <input type="text" className="cmd-input" style={{ flex: 1, borderBottom: "1px solid var(--border)" }} placeholder="Replace with…" value={replaceTerm} onChange={(e) => setReplaceTerm(e.target.value)} onKeyDown={onKeyDown} aria-label="Replace with" />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            <span>{matches.length > 0 ? `${currentIdx + 1} of ${matches.length} matches` : (term ? "No matches" : "Type to search")}</span>
            <div style={{ display: "flex", gap: "0.25rem" }}>
              <button type="button" onClick={() => setCurrentIdx((i) => (i - 1 + matches.length) % matches.length)} disabled={matches.length === 0} className="rounded p-1 border border-border hover:bg-surface disabled:opacity-50" aria-label="Previous"><ChevronUp className="h-4 w-4" /></button>
              <button type="button" onClick={() => setCurrentIdx((i) => (i + 1) % matches.length)} disabled={matches.length === 0} className="rounded p-1 border border-border hover:bg-surface disabled:opacity-50" aria-label="Next"><ChevronDown className="h-4 w-4" /></button>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={replaceCurrent} disabled={matches.length === 0} className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-surface disabled:opacity-50">Replace</button>
            <button type="button" onClick={replaceAll} disabled={matches.length === 0} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">Replace all</button>
          </div>
        </div>
      </div>
    </div>, document.body,
  );
}

function findMatches(editor: Editor, term: string, caseSensitive: boolean): Match[] {
  if (!term) return []; const matches: Match[] = []; const needle = caseSensitive ? term : term.toLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return; const haystack = caseSensitive ? node.text : node.text.toLowerCase();
    let from = 0; while (from <= haystack.length - needle.length) { const idx = haystack.indexOf(needle, from); if (idx === -1) break; matches.push({ pos: pos + idx, end: pos + idx + needle.length, text: node.text.slice(idx, idx + needle.length) }); from = idx + needle.length; }
    return false;
  });
  return matches;
}
