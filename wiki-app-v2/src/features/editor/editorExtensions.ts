import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import UniqueID from "@tiptap/extension-unique-id";
import { MermaidNode } from "./extensions/mermaid.js";
import { Image } from "./extensions/image.js";
import type { Extensions } from "@tiptap/react";

/**
 * Strips MS Word HTML on paste — keeps only semantic elements, discards
 * inline styles, mso-* classes, <span>/<font>/<div> wrappers, and Word
 * XML markup before Tiptap's parser sees the HTML. Without this, pasting
 * from Word produces "unknown node type" errors because <span
 * style="font-size:72pt"> has no Tiptap analogue.
 */
export function stripWordHTML(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch?.[1]) html = bodyMatch[1];

  html = html.replace(/\s*style="[^"]*"/gi, "");
  html = html.replace(/\s*class="[^"]*"/gi, "");
  html = html.replace(/<\/?(span|font|div)[^>]*>/gi, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<o:p><\/o:p>/gi, "");
  html = html.replace(/\n{3,}/g, "\n\n");

  return html;
}

/**
 * Characters that indicate the pasted text might be markdown rather than
 * plain prose — # heading, bullet, code fence, strikethrough, link, table.
 */
export const MD_HINTS = /^[#>\-*`]|~~|\[.+]\(.+\)|^\|.+\|/m;

/**
 * Base editor extensions — every page's editor is built from this list. The
 * plugin engine (slice 6) appends plugin-registered nodes/marks on top of it at
 * mount time; it never mutates this array.
 */
export function baseExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // Tiptap v3's StarterKit already bundles Link, Underline and Dropcursor;
      // the custom instances below carry the app's specific config and must not
      // be shadowed by StarterKit's defaults.
      link: false,
      underline: false,
      // §7.13: the dropcursor draws the blue drop-position line while a block
      // is dragged via the global drag handle. Keep it on StarterKit (not a
      // separate instance) so there is exactly one dropcursor plugin.
      dropcursor: { color: "var(--color-primary)", width: 2 },
    }),
    Underline,
    // "all" = every node except doc/text, mirroring ensureBlockIds — block ids
    // are a first-class invariant (comments/refs/backlinks), and the Yjs
    // collab schema MUST declare the id attr or the seed→store round-trip
    // silently drops every block id (a real bug found via the slice-11 gate).
    UniqueID.configure({ types: "all" }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      // Internal wiki links are stored as /api/branches/<id>/page — never
      // validated against a URL scheme so pasting one from another page works.
      isAllowedUri: () => true,
    }),
    Placeholder.configure({
      placeholder: "Write something…",
    }),
    MermaidNode,
    Image,
  ];
}
