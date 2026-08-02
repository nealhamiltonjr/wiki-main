import type { Editor as TiptapEditor } from "@tiptap/core";
import { markdownToTiptap } from "../../../server/services/markdown.service.js";

/**
 * Markdown-aware paste handler (Phase 2).
 *
 * Intercepts paste when the clipboard's plain-text payload actually contains
 * Markdown constructs and converts it to Tiptap JSON through the SAME converter
 * the server uses for git export / restore (`markdownToTiptap`), so pasted and
 * round-tripped content stay consistent. When the plain text has no Markdown,
 * the default handler runs untouched (which is what makes pasting rich HTML
 * from a browser keep its formatting).
 */

const MARKDOWN_PATTERNS = [
  /^#{1,6}\s/, // ATX headings
  /^[-*]\s+/, // bullet list items
  /^\d+\.\s+/, // ordered list items
  /^> /, // blockquotes
  /^```/, // fenced code blocks
  /^\s*[-*_]{3,}\s*$/, // horizontal rules
  /!\[[^\]]*\]\([^)]+\)/, // images
  /\[[^\]]+\]\([^)]+\)/, // links
  /[*_]{1,2}[^*_]+[*_]{1,2}/, // emphasis/strong
  /`[^`]+`/, // inline code
];

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_PATTERNS.some((re) => re.test(text));
}

export function handleMarkdownPaste(editor: TiptapEditor, event: ClipboardEvent): boolean {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  const text = clipboard.getData("text/plain");
  if (!text || !looksLikeMarkdown(text)) return false;

  event.preventDefault();
  const doc = markdownToTiptap(text);
  if (doc.content) {
    editor.chain().focus().insertContent(doc.content as any).run();
  }
  return true;
}
