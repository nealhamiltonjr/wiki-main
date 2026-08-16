import { resolveCodeLanguage } from "@/shared/codeLanguages";
import { useHighlightedCode } from "./useHighlightedCode.js";

export function CodePageReadOnly({ content, language }: { content: unknown; language?: string | null }) {
  const code = typeof content === "string" ? content : "";
  const highlighted = useHighlightedCode(code, language);
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
        {highlighted ? <code dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
}
