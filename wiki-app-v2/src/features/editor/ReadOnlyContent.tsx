import { useMemo } from "react";
import { safeLinkHref } from "@/shared/blockIds";
import { MermaidRenderer } from "./extensions/MermaidRenderer.js";
import { useEmbedTypeMap } from "@/plugins/registry";
import { highlightCode } from "./codeHighlight.js";

/**
 * Simple server-rendering-safe content renderer. Walks Tiptap JSON nodes into
 * semantic HTML. No editor instance, no dangerouslySetInnerHTML (except the
 * Prism-highlighted code block, whose output Prism escapes by construction).
 * Extracted from the branch page route so it can be unit-tested in isolation.
 */

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function ReadOnlyContent({ content }: { content: unknown }) {
  const doc = content as PMNode | null;
  const embedMap = useEmbedTypeMap();
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return null;

  return <>{doc.content.map((node, i) => <BlockNode key={i} node={node} embedMap={embedMap} />)}</>;
}

function InlineNode({ node }: { node: PMNode }) {
  if (node.type === "text") {
    let text: React.ReactNode = node.text ?? "";
    if (node.marks) {
      for (const m of node.marks) {
        if (m.type === "bold") text = <strong>{text}</strong>;
        if (m.type === "italic") text = <em>{text}</em>;
        if (m.type === "underline") text = <u>{text}</u>;
        if (m.type === "strike") text = <s>{text}</s>;
        if (m.type === "code") text = <code>{text}</code>;
        if (m.type === "link") {
          // Defense-in-depth on top of the save-time sanitizer (validateContent
          // neutralizes javascript:/data: schemes) — a legacy or hand-edited
          // doc must never render a script-capable href.
          const href = safeLinkHref((m.attrs?.href as string) ?? "#");
          text = <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">{text}</a>;
        }
      }
    }
    return <>{text}</>;
  }
  if (node.type === "hardBreak") return <br />;
  if (node.type === "mention") {
    // A mention node must never be invisible in read view — the editor shows
    // it as "@Name", so View mode renders the same label (the label is the
    // display name captured when the mention was inserted).
    const char = (node.attrs?.mentionSuggestionChar as string | undefined) ?? "@";
    const label = node.attrs?.label as string | undefined;
    return <span className="mention">{char}{label ?? ""}</span>;
  }
  return null;
}

function BlockNode({ node, embedMap }: { node: PMNode; embedMap: Map<string, import("@/plugins/defs.js").EmbedTypeDef> }) {
  const children = Array.isArray(node.content)
    ? node.content.map((n, i) => <InlineNode key={i} node={n} />)
    : null;

  switch (node.type) {
    case "paragraph":
      return children ? <p>{children}</p> : <p>&nbsp;</p>;
    case "heading": {
      const level = (node.attrs?.level as number) ?? 2;
      if (level === 1) return children ? <h1 id={node.attrs?.id as string | undefined}>{children}</h1> : null;
      if (level === 2) return children ? <h2 id={node.attrs?.id as string | undefined}>{children}</h2> : null;
      if (level === 3) return children ? <h3 id={node.attrs?.id as string | undefined}>{children}</h3> : null;
      return children ? <h4 id={node.attrs?.id as string | undefined}>{children}</h4> : null;
    }
    case "bulletList":
      return <ul>{node.content?.map((n, i) => <BlockNode key={i} node={n} embedMap={embedMap} />)}</ul>;
    case "orderedList":
      return <ol>{node.content?.map((n, i) => <BlockNode key={i} node={n} embedMap={embedMap} />)}</ol>;
    case "listItem":
      return <li>{children}</li>;
    case "blockquote":
      return <blockquote>{node.content?.map((n, i) => <BlockNode key={i} node={n} embedMap={embedMap} />)}</blockquote>;
    case "codeBlock": {
      const lang = (node.attrs as Record<string, unknown> | null)?.language as string | undefined;
      const code = (node.content as Array<{ text?: string }> | undefined)?.map((n) => n.text ?? "").join("\n") ?? "";
      return <CodeBlock code={code} language={lang} />;
    }
    case "horizontalRule":
      return <hr />;
    case "mermaidDiagram": {
      const source = (node.content as Array<{ text?: string }> | undefined)?.map((n) => n.text ?? "").join("\n") ?? "";
      return <MermaidRenderer source={source} />;
    }
    default: {
      // Plugin-provided embed types (§4.4 registerEmbedType) render through
      // their own read-only renderer. Unknown atom nodes (e.g. a node whose
      // plugin was disabled after save) fall through to the inert default —
      // never a throw, so a page with a disabled plugin's node still opens.
      const embed = embedMap.get(node.type);
      if (embed?.renderReadOnly) return <>{embed.renderReadOnly(node.attrs ?? {})}</>;
      return children ? <div>{children}</div> : null;
    }
  }
}

/**
 * Syntax-highlighted code block (§13.6). Uses Prism for lightweight
 * highlighting. In read mode, shows a language tag and highlighted code.
 */
function CodeBlock({ code, language }: { code: string; language?: string }) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);

  return (
    <div className="my-3 overflow-hidden rounded-md border border-border">
      {language ? (
        <div className="flex items-center justify-between border-b border-border bg-surface-hover px-3 py-1">
          <span className="text-xs font-medium text-text-muted uppercase">{language}</span>
        </div>
      ) : null}
      <pre className="overflow-x-auto p-3 text-sm leading-relaxed">
        {highlighted ? (
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}
