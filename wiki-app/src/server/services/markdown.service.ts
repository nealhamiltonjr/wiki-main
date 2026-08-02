/**
 * Converts canonical Tiptap/ProseMirror JSON (brief §3.1 - this IS the canonical
 * content format, not an intermediate one) into clean Markdown for Git export.
 *
 * This directly replaces the stub found in code review (§3.18) that wrote a
 * literal `# {slug}` regardless of actual page content. Deliberately dependency-free
 * (no remark/unified) so it has no failure mode beyond "unrecognized node type",
 * which is handled by falling through to plain text rather than throwing.
 *
 * Internal anchor IDs on headings (brief §3.1's internal-anchor mechanism) are
 * NOT emitted inline - per brief §3.13, exports must be clean, containing no
 * internal IDs/metadata. Anchors are resolved separately, at the reference-link
 * level, by the caller when it rewrites cross-page links.
 */

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function tiptapToMarkdown(doc: PMNode): string {
  if (!doc || doc.type !== "doc") return "";
  return (doc.content ?? []).map((node) => blockToMarkdown(node)).join("\n\n") + "\n";
}

function blockToMarkdown(node: PMNode, listDepth = 0): string {
  switch (node.type) {
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return `${"#".repeat(level)} ${inlineToMarkdown(node.content)}`;
    }
    case "paragraph":
      return inlineToMarkdown(node.content);
    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = (node.content ?? []).map((c) => c.text ?? "").join("");
      return "```" + lang + "\n" + code + "\n```";
    }
    case "blockquote":
      return (node.content ?? [])
        .map((c) => blockToMarkdown(c, listDepth))
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "bulletList":
      return (node.content ?? [])
        .map((li) => listItemToMarkdown(li, listDepth, "-"))
        .join("\n");
    case "orderedList": {
      let i = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map((li) => listItemToMarkdown(li, listDepth, `${i++}.`))
        .join("\n");
    }
    case "taskList":
      return (node.content ?? [])
        .map((li) => taskItemToMarkdown(li, listDepth))
        .join("\n");
    case "taskItem":
      return taskItemToMarkdown(node, listDepth);
    case "horizontalRule":
      return "---";
    case "image": {
      const src = (node.attrs?.src as string) ?? "";
      const alt = (node.attrs?.alt as string) ?? "";
      return `![${alt}](${src})`;
    }
    default:
      // Unrecognized block type - degrade to its inline text content rather than
      // dropping it silently or throwing. Better to export something imperfect
      // than nothing at all.
      return node.content ? inlineToMarkdown(node.content) : "";
  }
}

function listItemToMarkdown(li: PMNode, depth: number, marker: string): string {
  const indent = "  ".repeat(depth);
  const inner = (li.content ?? [])
    .map((c) => (c.type === "bulletList" || c.type === "orderedList" ? blockToMarkdown(c, depth + 1) : inlineToMarkdown(c.content)))
    .join("\n");
  const firstLine = inner.split("\n")[0] ?? "";
  const rest = inner.split("\n").slice(1).join("\n");
  return `${indent}${marker} ${firstLine}` + (rest ? `\n${rest}` : "");
}

function taskItemToMarkdown(li: PMNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const checked = Boolean(li.attrs?.checked);
  const inner = (li.content ?? [])
    .map((c) =>
      c.type === "taskList" || c.type === "bulletList" || c.type === "orderedList"
        ? blockToMarkdown(c, depth + 1)
        : inlineToMarkdown(c.content),
    )
    .join("\n");
  const firstLine = inner.split("\n")[0] ?? "";
  const rest = inner.split("\n").slice(1).join("\n");
  return `${indent}- [${checked ? "x" : " "}] ${firstLine}` + (rest ? `\n${rest}` : "");
}

function inlineToMarkdown(nodes: PMNode[] | undefined): string {
  if (!nodes) return "";
  return nodes.map(inlineNodeToMarkdown).join("");
}

function inlineNodeToMarkdown(node: PMNode): string {
  if (node.type === "hardBreak") return "  \n";
  if (node.type !== "text" || !node.text) return "";

  let text = node.text;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold": text = `**${text}**`; break;
      case "italic": text = `*${text}*`; break;
      case "code": text = `\`${text}\``; break;
      case "link": text = `[${text}](${mark.attrs?.href ?? ""})`; break;
      case "highlight": text = `==${text}==`; break;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Reverse: Markdown → Tiptap JSON
// ---------------------------------------------------------------------------

/**
 * Converts Markdown into the canonical Tiptap/ProseMirror JSON format.
 *
 * Deliberately dependency-free (no remark/unified), mirroring the forward
 * converter. Handles the same node and mark types: headings (1-6), paragraphs,
 * code blocks, blockquotes, bullet/ordered lists (including nesting),
 * horizontal rules, images (inline or standalone), and the inline marks bold,
 * italic, code, and link.
 *
 * Consecutive blank lines separate blocks. A single line break inside a
 * paragraph becomes a `hardBreak` node.
 */
export function markdownToTiptap(markdown: string): PMNode {
  const lines = markdown.split("\n");
  const blocks: PMNode[] = [];
  let i = 0;

  while (i < lines.length) {
    // skip blank lines
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length) break;

    const line = lines[i]!;

    // fenced code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        type: "codeBlock",
        attrs: lang ? { language: lang } : undefined,
        content: [{ type: "text", text: codeLines.join("\n") }],
      });
      continue;
    }

    // horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      blocks.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    // heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        attrs: { level: headingMatch[1]!.length },
        content: parseInline(headingMatch[2]!),
      });
      i++;
      continue;
    }

    // blockquote - collect consecutive > lines
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        quoteLines.push(lines[i]!.slice(2));
        i++;
      }
      const inner = quoteLines.map(ql => ({ type: "paragraph" as const, content: parseInline(ql) }));
      blocks.push({ type: "blockquote", content: inner });
      continue;
    }

    // task list item(s) - "- [ ]" / "- [x]" - collect consecutive items
    if (/^[-*]\s+\[[ xX]\]\s+/.test(line)) {
      const items = collectListItems(lines, i, /^[-*]\s+\[[ xX]\]\s+/, "taskItem", (_stripped, marker) => ({
        checked: marker.includes("[x]") || marker.includes("[X]"),
      }));
      i = items.nextIndex;
      blocks.push({ type: "taskList", content: items.nodes });
      continue;
    }

    // bullet list item(s) - collect consecutive items
    if (/^[-*]\s+/.test(line)) {
      const items = collectListItems(lines, i, /^[-*]\s+/);
      i = items.nextIndex;
      blocks.push({ type: "bulletList", content: items.nodes });
      continue;
    }

    // ordered list item(s)
    if (/^\d+\.\s+/.test(line)) {
      const items = collectListItems(lines, i, /^\d+\.\s+/);
      i = items.nextIndex;
      blocks.push({ type: "orderedList", content: items.nodes });
      continue;
    }

    // standalone image (whole line is just an image)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      blocks.push({ type: "paragraph", content: [
        { type: "image", attrs: { src: imgMatch[2]!, alt: imgMatch[1]! } },
      ]});
      i++;
      continue;
    }

    // paragraph - collect lines until next blank or block-level token
    const paraLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length === 1) {
      blocks.push({ type: "paragraph", content: parseInline(paraLines[0]!) });
    } else {
      // multiple consecutive non-blank lines → paragraph with hardBreaks
      const content: PMNode[] = [];
      for (let pi = 0; pi < paraLines.length; pi++) {
        for (const node of parseInline(paraLines[pi]!)) content.push(node);
        if (pi < paraLines.length - 1) content.push({ type: "hardBreak" });
      }
      blocks.push({ type: "paragraph", content });
    }
  }

  return { type: "doc", content: blocks };
}

function isBlockStart(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("```") || t.startsWith("#") || t.startsWith("> ") ||
    /^[-*_]{3,}\s*$/.test(t) || /^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t) ||
    /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.test(line);
}

type ListItemAcc = { nodes: PMNode[]; nextIndex: number };

function collectListItems(
  lines: string[],
  start: number,
  markerRe: RegExp,
  itemType: "listItem" | "taskItem" = "listItem",
  makeAttrs?: (stripped: string, marker: string) => Record<string, unknown>,
): ListItemAcc {
  const items: PMNode[] = [];
  let i = start;

  while (i < lines.length) {
    // detect nested list (indented)
    if (/^\s{2,}[-*]\s+/.test(lines[i]!) || /^\s{2,}\d+\.\s+/.test(lines[i]!)) {
      // consume all indented lines as nested content inside the last list item
      const nestedLines: string[] = [];
      while (i < lines.length && (lines[i]!.trim() === "" || lines[i]!.startsWith("  ") || lines[i]!.startsWith("\t"))) {
        if (lines[i]!.trim() === "") { i++; continue; }
        nestedLines.push(lines[i]!.replace(/^  /, ""));
        i++;
      }
      if (items.length > 0 && nestedLines.length > 0) {
        const nestedDoc = markdownToTiptap(nestedLines.join("\n"));
        const lastItem = items[items.length - 1]!;
        lastItem.content = [...(lastItem.content ?? []), ...(nestedDoc.content ?? [])];
      }
      continue;
    }

    if (lines[i]!.trim() === "") { i++; continue; }

    const match = lines[i]!.match(markerRe);
    if (!match) break; // not a list item - stop collecting
    const marker = match[0];
    const stripped = lines[i]!.slice(marker.length);

    // collect continuation lines for this list item (must be indented, so a
    // following unindented paragraph is NOT swallowed into the item)
    const itemLines = [stripped];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" &&
           !markerRe.test(lines[i]!) && !isBlockStart(lines[i]!) &&
           (lines[i]!.startsWith("  ") || lines[i]!.startsWith("\t"))) {
      itemLines.push(lines[i]!.replace(/^  /, "").replace(/^\t/, ""));
      i++;
    }

    const attrs = makeAttrs ? makeAttrs(stripped, marker) : undefined;
    const base = attrs ? { type: itemType, attrs, content: [] as PMNode[] } : { type: itemType, content: [] as PMNode[] };

    if (itemLines.length === 1) {
      base.content = [{ type: "paragraph", content: parseInline(itemLines[0]!) }];
      items.push(base);
    } else {
      const paras: PMNode[] = [];
      for (const il of itemLines) {
        paras.push({ type: "paragraph", content: parseInline(il) });
      }
      base.content = paras;
      items.push(base);
    }
  }

  return { nodes: items, nextIndex: i };
}

// Inline parser: bold, italic, code, link, image
function parseInline(text: string): PMNode[] {
  const nodes: PMNode[] = [];
  let pos = 0;

  while (pos < text.length) {
    // bold **...**
    const bold = matchDelimited(text, pos, "**");
    if (bold) { nodes.push(...markedText(bold.inner, "bold")); pos = bold.end; continue; }

    // highlight ==...==
    const highlight = matchDelimited(text, pos, "==");
    if (highlight) { nodes.push(...markedText(highlight.inner, "highlight")); pos = highlight.end; continue; }

    // italic *...* (single asterisk, not part of **)
    const italic = matchDelimited(text, pos, "*");
    if (italic) { nodes.push(...markedText(italic.inner, "italic")); pos = italic.end; continue; }

    // code `...`
    const code = matchDelimited(text, pos, "`");
    if (code) { nodes.push({ type: "text", text: code.inner, marks: [{ type: "code" }] }); pos = code.end; continue; }

    // link [text](url)
    if (text[pos] === "[") {
      const closeB = text.indexOf("]", pos);
      const openP = closeB > pos ? text.indexOf("(", closeB) : -1;
      const closeP = openP > closeB ? text.indexOf(")", openP) : -1;
      if (closeB > pos && openP === closeB + 1 && closeP > openP) {
        const linkText = text.slice(pos + 1, closeB);
        const href = text.slice(openP + 1, closeP);
        nodes.push({ type: "text", text: linkText, marks: [{ type: "link", attrs: { href } }] });
        pos = closeP + 1;
        continue;
      }
    }

    // image ![alt](src) — always standalone node, even inline
    const imgRe = /^!\[([^\]]*)\]\(([^)]+)\)/;
    const imgMatch = text.slice(pos).match(imgRe);
    if (imgMatch) {
      nodes.push({ type: "image", attrs: { src: imgMatch[2]!, alt: imgMatch[1]! } });
      pos += imgMatch[0].length;
      continue;
    }

    // plain text until next special char
    const next = text.slice(pos).search(/[*`\[!=]/);
    if (next === -1) {
      nodes.push({ type: "text", text: text.slice(pos) });
      break;
    }
    if (next === 0) {
      // Unmatched special char (lone "=", "!", "[", "*", "`" that isn't a
      // valid mark/image/link) — emit it literally so parsing always advances.
      nodes.push({ type: "text", text: text[pos]! });
      pos += 1;
      continue;
    }
    nodes.push({ type: "text", text: text.slice(pos, pos + next) });
    pos += next;
  }

  return nodes;
}

function matchDelimited(text: string, pos: number, delim: string): { inner: string; end: number } | null {
  if (text.slice(pos, pos + delim.length) !== delim) return null;
  const start = pos + delim.length;
  const end = text.indexOf(delim, start);
  if (end === -1) return null;
  return { inner: text.slice(start, end), end: end + delim.length };
}

function markedText(inner: string, markType: string): PMNode[] {
  // Text content with a mark — recursively parse inline content for nested marks
  const children = parseInline(inner);
  return children.map(c => ({
    ...c,
    marks: [...(c.marks ?? []), { type: markType }],
  }));
}
