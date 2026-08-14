/**
 * Block-ID utilities shared between server and client (brief §7.12, Phase 1).
 *
 * The canonical content format is Tiptap/ProseMirror JSON (brief §3.1). Every
 * block node carries an `id` attribute, assigned client-side by
 * @tiptap/extension-unique-id. The server may process content that never went
 * through a live editor (restored Markdown, template content, imports), so
 * these pure JSON-walking functions handle backfilling, lookup, and position
 * math entirely on the JSON itself - no schema, no Editor instance, no
 * extension registry required.
 *
 * Position conventions mirror ProseMirror: a text node of length L occupies
 * positions [start, start + L); a leaf atom (image, hardBreak, mention, ...)
 * occupies exactly 1 position; a node with content occupies 2 + the sum of its
 * children (one opening position, the children, one closing position).
 */

export interface JSONBlock {
  type: string;
  attrs?: Record<string, unknown> & { id?: string };
  content?: JSONBlock[];
  text?: string;
  [key: string]: unknown;
}

const INLINE_TYPES = new Set(["text", "hardBreak"]);

/** Whether a node type is a block node that should carry an id. */
export function isBlockType(type: string): boolean {
  return type !== "doc" && !INLINE_TYPES.has(type);
}

/** Default id generator - nanoid-style, 12 chars, URL-safe (matches the client extension). */
const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
export function defaultGenerateId(): string {
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  }
  return id;
}

// ---------------------------------------------------------------------------
// Content integrity validation (§11.4). Every write path calls these to
// ensure the ProseMirror JSON document is structurally sound, every block node
// has an id, and the document matches a known-good shape before persisting.
// ---------------------------------------------------------------------------

/** Result of content validation. Errors are user-visible — they indicate the
 *  client sent something structurally invalid (corrupted edit, bad paste). */
export interface ContentValidation {
  ok: boolean;
  errors: string[];
}

// Known safe block types (Tiptap StarterKit + our extensions). Unknown block
// types are rejected — a stray HTML node from a paste is not persisted.
export const KNOWN_BLOCK_TYPES = new Set([
  "paragraph", "heading", "bulletList", "orderedList", "listItem",
  "blockquote", "codeBlock", "horizontalRule", "image", "table",
  "tableRow", "tableCell", "taskList", "taskItem", "details",
  "detailsContent", "detailsSummary", "mermaidDiagram",
]);

export const KNOWN_INLINE_TYPES = new Set([
  "text", "hardBreak", "mention",
]);

export const KNOWN_MARK_TYPES = new Set([
  "bold", "italic", "underline", "strike", "code", "link",
]);

/**
 * Only schemes that can never execute script are allowed through to an <a href>
 * in any renderer. `javascript:` (and data:/vbscript:) hrefs are a stored-XSS
 * vector: they can be pasted into the editor (the Link extension's isAllowedUri
 * is deliberately permissive) but must be neutralized before the content is
 * persisted or rendered. Relative (internal wiki links) and fragment hrefs are
 * fine.
 */
export function safeLinkHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!schemeMatch) return trimmed; // no scheme — e.g. "example.com/path"
  const scheme = schemeMatch[1]!.toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") return trimmed;
  return "#";
}

/**
 * Mirror of safeLinkHref but stricter — image sources can never legitimately
 * be mailto/tel, and `data:` is unsafe in <img src> because:
 *   - data:text/html can carry script (the browser blocks it as an image,
 *     but the URL itself is suspicious)
 *   - data:image/svg+xml can carry script via SVG <script> or onload
 *   - data:application/xml can carry XXE payloads in old browsers
 * Returning "" (instead of "#") is intentional: a link with an empty href is
 * still navigable to nothing, but a broken <img src=""> renders more honestly
 * as an empty/broken image than <img src="#">. The renderer / markdown parser
 * drops the whole image node when its src sanitizes to "" — no zombie
 * placeholder, no chance of a future renderer misinterpreting "#".
 */
export function safeImageSrc(src: string): string {
  const trimmed = src.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!schemeMatch) return trimmed; // no scheme — e.g. "example.com/x.png"
  const scheme = schemeMatch[1]!.toLowerCase();
  if (scheme === "http" || scheme === "https") return trimmed;
  return "";
}

/**
 * Validates a Tiptap JSON document tree before persisting. Catches the three
 * most common failure modes from past bugs:
 *  1. Pasting from Word leaves inline style attributes / stray spans that
 *     aren't valid ProseMirror node types — reject.
 *  2. A node is missing its "id" attribute (the unique-id extension didn't
 *     fire, or the content came from a non-editor source) — auto-repair.
 *  3. The document is empty or not a "doc" node — auto-repair.
 *
 * Returns the (possibly repaired) document and any validation errors.
 */
export function validateContent(
  input: unknown,
  opts?: { extraNodeTypes?: Set<string>; extraMarkTypes?: Set<string> },
): { doc: JSONBlock; errors: string[] } {
  const errors: string[] = [];

  if (!input || typeof input !== "object") {
    return { doc: { type: "doc", content: [{ type: "paragraph" }] }, errors: ["Content is empty or not an object"] };
  }

  let doc = input as JSONBlock;

  // Auto-repair: if this is a typed block that's not a 'doc', wrap it.
  if (doc.type !== "doc") {
    const content = typeof doc.type === "string" ? [doc] : [{ type: "paragraph" }];
    doc = { type: "doc", content };
    errors.push("Content root is not a 'doc' node — auto-wrapped");
  }

  if (!Array.isArray(doc.content) || doc.content.length === 0) {
    doc = { ...doc, content: [{ type: "paragraph" }] };
    errors.push("Document has no content — auto-filled with empty paragraph");
  }

  // Validate recursively.
  const walk = (node: JSONBlock, path: string): void => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      errors.push(`${path}: node has no type`);
      return;
    }

    const type = node.type;
    const isInline = KNOWN_INLINE_TYPES.has(type);
    const isKnown = KNOWN_BLOCK_TYPES.has(type) || isInline || type === "doc"
      || (opts?.extraNodeTypes?.has(type) ?? false);

    if (!isKnown) {
      errors.push(`${path}: unknown node type "${type}" — rejected`);
      return;
    }

    if (isBlockType(type) || (opts?.extraNodeTypes?.has(type) ?? false)) {
      if (!node.attrs?.id) {
        node.attrs = { ...(node.attrs ?? {}), id: defaultGenerateId() };
        errors.push(`${path}: block "${type}" missing id — auto-assigned`);
      }
    }

    // Sanitize image src at persist time (defense in depth: the markdown
    // parser already calls safeImageSrc, but a hand-edited doc or a future
    // importer must not bypass this).
    if (type === "image" && typeof node.attrs?.src === "string") {
      const safe = safeImageSrc(node.attrs.src as string);
      if (safe !== node.attrs.src) {
        node.attrs = { ...node.attrs, src: safe };
        errors.push(`${path}: unsafe image src — neutralized`);
      }
    }

    if (Array.isArray(node.content)) {
      node.content.forEach((child, i) => walk(child, `${path}/content[${i}]`));
    }

    // Validate marks on inline nodes.
    if (isInline && Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        const markKnown = KNOWN_MARK_TYPES.has(mark.type) || (opts?.extraMarkTypes?.has(mark.type) ?? false);
        if (typeof mark.type !== "string" || !markKnown) {
          errors.push(`${path}: unknown mark type "${String(mark.type)}"`);
        }
        // Neutralize script-capable link schemes before persisting.
        if (mark.type === "link" && typeof mark.attrs?.href === "string") {
          const safe = safeLinkHref(mark.attrs.href as string);
          if (safe !== mark.attrs.href) {
            mark.attrs = { ...mark.attrs, href: safe };
            errors.push(`${path}: unsafe link scheme — neutralized`);
          }
        }
      }
    }
  };

  const children = (doc as JSONBlock).content ?? [];
  let i = 0;
  for (const child of children) {
    walk(child, `content[${i++}]`);
  }

  return { doc, errors };
}

/** ProseMirror-style size of a node in the JSON tree. */
function nodeSize(node: JSONBlock): number {
  if (node.type === "text") return node.text?.length ?? 0;
  if (node.type === "hardBreak") return 1;
  if (Array.isArray(node.content)) {
    return 2 + node.content.reduce((acc, child) => acc + nodeSize(child), 0);
  }
  return 1; // leaf atom (image, horizontalRule, mention, ...)
}

/**
 * Recursively assigns a fresh id to every block node missing one. Pure -
 * returns a NEW document tree; the input is untouched.
 */
export function ensureBlockIds(doc: JSONBlock, generate: () => string = defaultGenerateId): JSONBlock {
  if (!doc || typeof doc !== "object") return doc;
  const out: JSONBlock = { ...doc };
  if (isBlockType(out.type) && !out.attrs?.id) {
    out.attrs = { ...(out.attrs ?? {}), id: generate() };
  }
  if (Array.isArray(out.content)) {
    out.content = out.content.map((child) => ensureBlockIds(child, generate));
  }
  return out;
}

/** Collects every block id in the doc, in document order (duplicates possible). */
export function collectBlockIds(doc: JSONBlock): string[] {
  const ids: string[] = [];
  const walk = (node: JSONBlock): void => {
    if (isBlockType(node.type) && typeof node.attrs?.id === "string") ids.push(node.attrs.id);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return ids;
}

/**
 * Returns the ProseMirror position range [from, to) of the block with the
 * given id, or null if no such block exists. `from`/`to` are valid positions
 * for a TextSelection spanning the block's content.
 */
export function blockRangeForId(doc: JSONBlock, blockId: string): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null;
  const walk = (node: JSONBlock, start: number): number => {
    const size = nodeSize(node);
    if (result === null && isBlockType(node.type) && node.attrs?.id === blockId) {
      result = { from: start, to: start + size };
    }
    if (node.type === "text" || node.type === "hardBreak") return size;
    if (Array.isArray(node.content)) {
      let offset = start + 1;
      for (const child of node.content) offset += walk(child, offset);
    }
    return size;
  };
  walk(doc, 0);
  return result;
}

/**
 * Returns the id of the DEEPEST block containing the given position, or null
 * if the position is inside no block (e.g. empty doc or a position in the
 * doc wrapper itself).
 */
export function blockIdAtPosition(doc: JSONBlock, pos: number): string | null {
  let found: string | null = null;
  const walk = (node: JSONBlock, start: number): number => {
    const size = nodeSize(node);
    if (isBlockType(node.type) && pos >= start && pos < start + size) {
      found = (node.attrs?.id as string | undefined) ?? null;
    }
    if (node.type === "text" || node.type === "hardBreak") return size;
    if (Array.isArray(node.content)) {
      let offset = start + 1;
      for (const child of node.content) offset += walk(child, offset);
    }
    return size;
  };
  walk(doc, 0);
  return found;
}

/**
 * Strips (or converts) block nodes whose type is not in the allowed set, so a
 * Tiptap schema built without the disabled plugin's extension doesn't throw
 * "unknown node type" on load. Unknown block nodes become paragraphs
 * (preserving text content recursively); unknown inline nodes become plain
 * text. This runs both server-side (collab seed) and client-side (editor
 * mount) so disabled-plugin content is always survivable (§4.4).
 */
export function filterUnknownNodes(
  doc: JSONBlock,
  knownBlockTypes: ReadonlySet<string>,
  knownInlineTypes: ReadonlySet<string>,
  knownMarkTypes: ReadonlySet<string>,
): JSONBlock {
  const walk = (node: JSONBlock): JSONBlock => {
    if (!node || typeof node.type !== "string") return { type: "text", text: "" };

    const type = node.type;
    if (type === "doc") {
      const content = Array.isArray(node.content) ? node.content.map(walk) : [{ type: "paragraph" }];
      return { ...node, content };
    }
    if (knownInlineTypes.has(type)) {
      const n = { ...node };
      if (Array.isArray(node.marks)) {
        n.marks = node.marks.filter(m => knownMarkTypes.has(m.type));
      }
      return n;
    }
    if (!knownBlockTypes.has(type)) {
      // Unknown block → paragraph with child text
      const gatherText = (n: JSONBlock): string => {
        if (n.type === "text") return n.text ?? "";
        if (Array.isArray(n.content)) return n.content.map(gatherText).join("");
        return "";
      };
      const text = gatherText(node);
      return text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
    }
    const out = { ...node };
    if (Array.isArray(node.content)) {
      out.content = node.content.map(walk);
    }
    return out;
  };

  return walk(doc);
}
