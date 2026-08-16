import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import UniqueID from "@tiptap/extension-unique-id";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import Highlight from "@tiptap/extension-highlight";
import Mention from "@tiptap/extension-mention";
import { MermaidNode } from "./extensions/mermaid.js";
import { Image } from "./extensions/image.js";
import { Wikilink } from "./extensions/wikilink.js";
import { Attachment } from "./extensions/attachmentExtension.js";
import type { Extensions } from "@tiptap/react";

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

export const MD_HINTS = /^[#>\-*`]|~~|\[.+]\(.+\)|^\|.+\|/m;

export function baseExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: false, underline: false,
      dropcursor: { color: "var(--color-primary)", width: 2 },
    }),
    Underline,
    UniqueID.configure({ types: "all" }),
    Link.configure({ openOnClick: false, autolink: true, isAllowedUri: () => true }),
    Placeholder.configure({ placeholder: "Write something…" }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Typography,
    Highlight,
    Mention.configure({ HTMLAttributes: { class: "mention", "data-mention": "user" }, suggestion: undefined }),
    MermaidNode,
    Image,
    Wikilink,
    Attachment,
  ];
}
