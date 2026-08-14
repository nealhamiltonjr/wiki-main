import { useMemo } from "react";
import { resolveCodeLanguage } from "@/shared/codeLanguages";
import { highlightCode } from "./codeHighlight.js";

/**
 * Read-only renderer for a §13.6 code page — the whole page IS a
 * syntax-highlighted source/config file. Reuses the same Prism path as the
 * embedded code block so the language alias map and highlighter never drift.
 */
export function CodePageReadOnly({ content, language }: { content: unknown; language?: string | null }) {
  const code = typeof content === "string" ? content : "";
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const info = resolveCodeLanguage(language);

  return (
    <div className="overflow-hidden rounded-md border border-border" data-testid="code-page-read-only">
      {language ? (
        <div className="flex items-center justify-between border-b border-border bg-surface-hover px-3 py-1.5">
          <span className="text-xs font-medium text-text-muted uppercase">{info.label}</span>
          <span className="text-xs text-text-muted/70">.{info.ext}</span>
        </div>
      ) : null}
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed font-mono">
        {highlighted ? (
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}
