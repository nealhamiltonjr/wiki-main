import { useEffect, useState } from "react";
import { highlightCode } from "./codeHighlight.js";

export function useHighlightedCode(code: string, language: string | null | undefined): string | null {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    highlightCode(code, language).then((h) => { if (!cancelled) setHtml(h); }).catch(() => { if (!cancelled) setHtml(null); });
    return () => { cancelled = true; };
  }, [code, language]);
  return html;
}
