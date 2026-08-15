import { useEffect, useRef, useState } from "react";
import { sanitizeMermaidSvg } from "./sanitizeSvg.js";

/**
 * Renders a Mermaid diagram from source text as an inline SVG (§13.6).
 * Only used in read mode — in edit mode, the Tiptap Editor renders the node
 * as a pre/code block natively.
 *
 * The output of `mermaid.render()` is sanitized via DOMPurify before being
 * injected into the DOM (see `sanitizeSvg.ts`). Defense-in-depth against the
 * CVE pattern that hits Docmost, GitLab, Dify, and OneUptime — see the comment
 * in `sanitizeSvg.ts` for the full reasoning.
 */
export function MermaidRenderer({ source }: { source: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const id = ++renderId.current;

    const render = async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        if (cancelled) return;

        mermaid.initialize({ startOnLoad: false, theme: "neutral" });
        const { svg: result } = await mermaid.render(`mermaid-${id}`, source);
        if (!cancelled) setSvg(sanitizeMermaidSvg(result));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Diagram render error");
          setSvg(null);
        }
      }
    };

    render();
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div className="my-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
        <p className="font-semibold">Mermaid render error</p>
        <pre className="mt-1 whitespace-pre-wrap font-mono">{error}</pre>
      </div>
    );
  }

  if (svg) {
    return (
      <div
        ref={containerRef}
        className="mermaid-render my-4 flex justify-center overflow-x-auto rounded-md border border-border bg-surface p-4"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  return (
    <div ref={containerRef} className="my-4 animate-pulse rounded-md border border-border bg-surface p-8" />
  );
}
