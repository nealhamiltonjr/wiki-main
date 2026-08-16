import { useMemo } from "react";
import {
  blockRangeForId,
  nodeSize,
  safeLinkHref,
  safeImageSrc,
  type JSONBlock,
} from "@/shared/blockIds";
import { MermaidRenderer } from "./extensions/MermaidRenderer.js";
import { useEmbedTypeMap } from "@/plugins/registry";
import { highlightCode } from "./codeHighlight.js";

/**
 * Simple server-rendering-safe content renderer. Walks Tiptap JSON nodes into
 * semantic HTML. No editor instance, no dangerouslySetInnerHTML (except the
 * Prism-highlighted code block, whose output Prism escapes by construction).
 * Extracted from the branch page route so it can be unit-tested in isolation.
 */

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/**
 * Sliver of a CommentThread that the read view needs to wrap commented ranges
 * in <mark>. Same shape as the editor-side `CommentThreadLite` but imported
 * from the read-view side so the read view stays a pure renderer and can be
 * unit-tested with a plain array.
 */
export interface ReadOnlyCommentThread {
  id: string;
  blockId: string | null;
  rangeFrom: number;
  rangeTo: number;
  selection: string | null;
  resolvedAt: string | null;
}

interface ResolvedHighlight {
  threadId: string;
  title: string;
  from: number;
  to: number;
}

/**
 * Compute, for each unresolved thread, an absolute range covering just the
 * commented text inside its block. Reads the doc as JSON so the read view
 * matches the editor's `blockRangeForId` math character-for-character.
 */
function resolveHighlights(
  doc: PMNode,
  threads: readonly ReadOnlyCommentThread[],
): ResolvedHighlight[] {
  if (threads.length === 0) return [];
  const out: ResolvedHighlight[] = [];
  for (const t of threads) {
    if (t.resolvedAt || !t.blockId) continue;
    const blockRange = blockRangeForId(doc as JSONBlock, t.blockId);
    if (!blockRange) continue;
    const from = Math.min(
      Math.max(blockRange.from + t.rangeFrom, blockRange.from),
      blockRange.to,
    );
    const to = Math.min(
      Math.max(blockRange.from + t.rangeTo, from),
      blockRange.to,
    );
    if (from >= to) continue;
    const selection = t.selection ?? "";
    const preview = selection.length > 120 ? `${selection.slice(0, 120)}…` : selection;
    out.push({
      threadId: t.id,
      title: preview ? `Comment: "${preview}"` : "Comment",
      from,
      to,
    });
  }
  return out;
}

/**
 * Slice a single text node's string by the highlights that fall inside it,
 * wrapping the matched slices in <mark>. Adjacent or overlapping slices are
 * kept distinct so a single text node can carry several inline comments.
 */
function sliceTextByHighlights(
  text: string,
  offset: number,
  highlights: readonly ResolvedHighlight[],
): React.ReactNode[] {
  if (highlights.length === 0) return [text];
  // Split the text into pieces, splitting at every highlight boundary that
  // falls inside this text node. Walk in order and emit either a plain string
  // slice or a <mark>.
  const pieces: React.ReactNode[] = [];
  let cursor = offset;
  const textEnd = offset + text.length;
  type Interval = { start: number; end: number; h: ResolvedHighlight };
  const intervals: Interval[] = [];
  for (const h of highlights) {
    const start = Math.max(h.from, cursor);
    const end = Math.min(h.to, textEnd);
    if (end <= start) continue;
    intervals.push({ start, end, h });
  }
  if (intervals.length === 0) return [text];
  for (const iv of intervals) {
    if (iv.start > cursor) pieces.push(text.slice(cursor - offset, iv.start - offset));
    pieces.push(
      <mark
        key={`${cursor}-${iv.start}`}
        className="comment-highlight"
        data-thread-id={iv.h.threadId}
        title={iv.h.title}
      >
        {text.slice(iv.start - offset, iv.end - offset)}
      </mark>,
    );
    cursor = iv.end;
  }
  if (cursor < textEnd) pieces.push(text.slice(cursor - offset));
  return pieces;
}

export function ReadOnlyContent({
  content,
  commentThreads,
  onCommentThreadClick,
}: {
  content: unknown;
  commentThreads?: readonly ReadOnlyCommentThread[];
  onCommentThreadClick?: (threadId: string) => void;
}) {
  const doc = content as PMNode | null;
  const embedMap = useEmbedTypeMap();
  const highlights = useMemo(
    () => (doc && Array.isArray(doc.content) ? resolveHighlights(doc as PMNode, commentThreads ?? []) : []),
    [doc, commentThreads],
  );
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return null;
  const children = doc.content;
  const renderTop = (handler: ((threadId: string) => void) | undefined) => (
    <div
      onClick={(e) => {
        if (!handler) return;
        const target = e.target as HTMLElement | null;
        if (!(target instanceof HTMLElement)) return;
        const mark = target.closest("[data-thread-id]");
        if (!(mark instanceof HTMLElement)) return;
        const id = mark.getAttribute("data-thread-id");
        if (id) handler(id);
      }}
    >
      {children.map((node, i) => (
        <BlockNode
          key={i}
          node={node}
          embedMap={embedMap}
          highlights={highlights}
          startOffset={childOffsetAt(children, i)}
        />
      ))}
    </div>
  );
  if (!onCommentThreadClick) {
    return <>{children.map((node, i) => <BlockNode key={i} node={node} embedMap={embedMap} highlights={[]} startOffset={childOffsetAt(children, i)} />)}</>;
  }
  return renderTop(onCommentThreadClick);
}

/**
 * Fallback (no click handler provided) — render the doc without any wrapper so
 * the read view stays a pure renderer (used by tests).
 */
export function ReadOnlyContentPlain({ content }: { content: unknown }) {
  return <ReadOnlyContent content={content} />;
}

function InlineNode({
  node,
  blockOffset,
  highlights,
}: {
  node: PMNode;
  blockOffset: number;
  highlights: readonly ResolvedHighlight[];
}) {
  if (node.type === "text") {
    const text = node.text ?? "";
    let pieces: React.ReactNode = text;
    if (highlights.length > 0) {
      pieces = sliceTextByHighlights(text, blockOffset, highlights);
    }
    let rendered: React.ReactNode = pieces;
    if (node.marks) {
      for (const m of node.marks) {
        if (m.type === "bold") rendered = <strong>{rendered}</strong>;
        if (m.type === "italic") rendered = <em>{rendered}</em>;
        if (m.type === "underline") rendered = <u>{rendered}</u>;
        if (m.type === "strike") rendered = <s>{rendered}</s>;
        if (m.type === "code") rendered = <code>{rendered}</code>;
        if (m.type === "link") {
          // Defense-in-depth on top of the save-time sanitizer (validateContent
          // neutralizes javascript:/data: schemes) — a legacy or hand-edited
          // doc must never render a script-capable href.
          const href = safeLinkHref((m.attrs?.href as string) ?? "#");
          rendered = (
            <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">
              {rendered}
            </a>
          );
        }
      }
    }
    return <>{rendered}</>;
  }
  if (node.type === "hardBreak") return <br />;
  if (node.type === "image") {
    // Persist-time sanitization already neutralized unsafe srcs; this is the
    // render-time guard for hand-edited/legacy docs.
    const src = safeImageSrc((node.attrs?.src as string) ?? "");
    if (src === "") return null;
    return <img src={src} alt={(node.attrs?.alt as string) ?? ""} title={(node.attrs?.title as string) ?? undefined} className="my-1 max-w-full rounded" loading="lazy" />;
  }
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

function BlockNode({
  node,
  embedMap,
  highlights,
  startOffset,
}: {
  node: PMNode;
  embedMap: Map<string, import("@/plugins/defs.js").EmbedTypeDef>;
  highlights: readonly ResolvedHighlight[];
  startOffset: number;
}) {
  // Filter highlights to this block's region only — every block node passes
  // its own [start, start+nodeSize) span + the relevant slice down so
  // InlineNode can compute mark wrapping without a global layout walker.
  const blockRange = blockLen(node);
  const blockStart = startOffset + 1; // skip the block's open token
  const blockEnd = startOffset + blockRange;
  const local = highlights.filter((h) => h.to > blockStart && h.from < blockEnd);

  const children = Array.isArray(node.content)
    ? node.content.map((n, i) => {
        // Inline children live inside the block; the block's first child sits
        // at startOffset + 1 (after the open token), and each previous
        // sibling's nodeSize is added on top. ProseMirror's `text` node has no
        // open/close tokens so its size equals its content length — matches
        // `nodeSize` in `shared/blockIds.ts`.
        const off = startOffset + 1 + childOffsetAt(node.content!, i);
        return (
          <InlineNode key={i} node={n} blockOffset={off} highlights={local} />
        );
      })
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
      return (
        <ul>
          {node.content?.map((n, i) => (
            <BlockNode
              key={i}
              node={n}
              embedMap={embedMap}
              highlights={highlights}
              startOffset={startOffset + 1 + childOffsetAt(node.content!, i)}
            />
          ))}
        </ul>
      );
    case "orderedList":
      return (
        <ol>
          {node.content?.map((n, i) => (
            <BlockNode
              key={i}
              node={n}
              embedMap={embedMap}
              highlights={highlights}
              startOffset={startOffset + 1 + childOffsetAt(node.content!, i)}
            />
          ))}
        </ol>
      );
    case "listItem":
      return <li>{children}</li>;
    case "blockquote":
      return (
        <blockquote>
          {node.content?.map((n, i) => (
            <BlockNode
              key={i}
              node={n}
              embedMap={embedMap}
              highlights={highlights}
              startOffset={startOffset + 1 + childOffsetAt(node.content!, i)}
            />
          ))}
        </blockquote>
      );
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

// JSONBlock mirror used only inside the read-view offset walker (the editor
// uses the same nodeSize via `shared/blockIds`; we replicate the shape here
// so we don't have to import the editor's full schema to render statically).
function blockLen(node: PMNode): number {
  return nodeSize(node as unknown as JSONBlock);
}

function childOffsetAt(arr: PMNode[], idx: number): number {
  // For a sequence of sibling nodes, the cumulative nodeSize of nodes [0..idx)
  // gives the offset of arr[idx] relative to its parent.
  let offset = 0;
  for (let i = 0; i < idx; i++) {
    const sib = arr[i];
    if (!sib) continue;
    offset += blockLen(sib);
  }
  return offset;
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
