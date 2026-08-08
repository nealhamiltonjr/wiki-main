import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import UniqueID from "@tiptap/extension-unique-id";
import type { Extensions } from "@tiptap/react";

/**
 * Base editor extensions — every page's editor is built from this list. The
 * plugin engine (slice 6) appends plugin-registered nodes/marks on top of it at
 * mount time; it never mutates this array.
 */
export function baseExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
    }),
    Underline,
    UniqueID,
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
  ];
}
