import { useEffect, useRef } from "react";
import { resolveCodeLanguage } from "@/shared/codeLanguages";

/**
 * §13.6 code-page editor: a plain monospace textarea for whole-file source.
 * Syntax highlighting happens in read view; the editor itself stays a true
 * text editor (no contentEditable DOM tricks that would fight undo/paste).
 * Autosave is wired by the caller so this component stays a pure controlled
 * input.
 */
export function CodePageEditor({
  value,
  language,
  onChange,
  autoFocus,
}: {
  value: string;
  language?: string | null;
  onChange: (next: string) => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const info = resolveCodeLanguage(language);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {language ? (
        <div className="flex items-center justify-between border-b border-border bg-surface-hover px-3 py-1.5">
          <span className="text-xs font-medium text-text-muted uppercase">{info.label}</span>
          <span className="text-xs text-text-muted/70">.{info.ext}</span>
        </div>
      ) : null}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-relaxed
                   outline-none focus:outline-none text-text placeholder:text-text-muted/50"
        placeholder="// Start typing code…"
        data-testid="code-page-editor"
      />
    </div>
  );
}
