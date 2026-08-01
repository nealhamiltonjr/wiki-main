/**
 * Core editor features registered through the plugin engine.
 *
 * Every slash command and toolbar button goes through the same
 * register*() calls that a third-party plugin would use — this
 * proves the registration surface is sound (per the original
 * design principle: dogfood your own API).
 *
 * Import this once at app startup to populate the registry.
 */

import {
  registerSlashCommand,
  registerToolbarButton,
  registerEditorExtension,
} from "./pluginEngine.js";
import { SlashCommandExtension } from "./slashCommandExtension.js";
import type { Editor as TiptapEditor } from "@tiptap/core";

// ---------------------------------------------------------------------------
// Register the slash-command Tiptap extension itself
// ---------------------------------------------------------------------------
registerEditorExtension(SlashCommandExtension);

// ---------------------------------------------------------------------------
// Slash commands — grouped by category
// ---------------------------------------------------------------------------

function headingCmd(level: 1 | 2 | 3 | 4 | 5 | 6) {
  registerSlashCommand({
    name: `heading${level}`,
    group: "Headings",
    label: `Heading ${level}`,
    icon: `H${level}`,
    description: level === 1 ? "Page title" : level === 2 ? "Section heading" : "Subsection heading",
    command: ({ editor }) => editor.chain().focus().toggleHeading({ level }).run(),
  });
}
headingCmd(1);
headingCmd(2);
headingCmd(3);
headingCmd(4);
headingCmd(5);
headingCmd(6);

registerSlashCommand({
  name: "paragraph",
  group: "Text",
  label: "Paragraph",
  icon: "¶",
  description: "Plain text block",
  command: ({ editor }) => editor.chain().focus().setParagraph().run(),
});

registerSlashCommand({
  name: "blockquote",
  group: "Text",
  label: "Blockquote",
  icon: "❝",
  description: "Quoted text block",
  command: ({ editor }) => editor.chain().focus().toggleBlockquote().run(),
});

registerSlashCommand({
  name: "codeBlock",
  group: "Text",
  label: "Code block",
  icon: "</>",
  description: "Fenced code block with syntax highlighting",
  command: ({ editor }) => editor.chain().focus().toggleCodeBlock().run(),
});

registerSlashCommand({
  name: "bulletList",
  group: "Lists",
  label: "Bullet list",
  icon: "•",
  description: "Unordered list",
  command: ({ editor }) => editor.chain().focus().toggleBulletList().run(),
});

registerSlashCommand({
  name: "orderedList",
  group: "Lists",
  label: "Numbered list",
  icon: "1.",
  description: "Ordered list",
  command: ({ editor }) => editor.chain().focus().toggleOrderedList().run(),
});

registerSlashCommand({
  name: "horizontalRule",
  group: "Content",
  label: "Divider",
  icon: "—",
  description: "Horizontal rule / separator line",
  command: ({ editor }) => editor.chain().focus().setHorizontalRule().run(),
});

registerSlashCommand({
  name: "image",
  group: "Content",
  label: "Image",
  icon: "🖼",
  description: "Insert an image by URL",
  command: ({ editor }) => {
    const src = window.prompt("Image URL:");
    if (src) editor.chain().focus().setImage({ src }).run();
  },
});

// ---------------------------------------------------------------------------
// Toolbar buttons — same registry, different consumer
// ---------------------------------------------------------------------------

registerToolbarButton({
  name: "bold",
  label: "B",
  title: "Bold (Ctrl+B)",
  group: "marks",
  isActive: (ed: TiptapEditor) => ed.isActive("bold"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleBold().run(),
});

registerToolbarButton({
  name: "italic",
  label: "I",
  title: "Italic (Ctrl+I)",
  group: "marks",
  isActive: (ed: TiptapEditor) => ed.isActive("italic"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleItalic().run(),
});

registerToolbarButton({
  name: "underline",
  label: "U",
  title: "Underline (Ctrl+U)",
  group: "marks",
  isActive: (ed: TiptapEditor) => ed.isActive("underline"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleUnderline().run(),
});

registerToolbarButton({
  name: "code",
  label: "</>",
  title: "Inline code",
  group: "marks",
  isActive: (ed: TiptapEditor) => ed.isActive("code"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleCode().run(),
});

registerToolbarButton({
  name: "link",
  label: "🔗",
  title: "Insert link",
  group: "marks",
  isActive: (ed: TiptapEditor) => ed.isActive("link"),
  onClick: (ed: TiptapEditor) => {
    const prev = ed.getAttributes("link").href ?? "";
    const href = window.prompt("URL:", prev);
    if (href === null) return;
    if (href === "") ed.chain().focus().unsetLink().run();
    else ed.chain().focus().setLink({ href }).run();
  },
});

registerToolbarButton({
  name: "heading1",
  label: "H1",
  title: "Heading 1",
  group: "headings",
  isActive: (ed: TiptapEditor) => ed.isActive("heading", { level: 1 }),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleHeading({ level: 1 }).run(),
});

registerToolbarButton({
  name: "heading2",
  label: "H2",
  title: "Heading 2",
  group: "headings",
  isActive: (ed: TiptapEditor) => ed.isActive("heading", { level: 2 }),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleHeading({ level: 2 }).run(),
});

registerToolbarButton({
  name: "heading3",
  label: "H3",
  title: "Heading 3",
  group: "headings",
  isActive: (ed: TiptapEditor) => ed.isActive("heading", { level: 3 }),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleHeading({ level: 3 }).run(),
});

registerToolbarButton({
  name: "bulletList",
  label: "• List",
  title: "Bullet list",
  group: "blocks",
  isActive: (ed: TiptapEditor) => ed.isActive("bulletList"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleBulletList().run(),
});

registerToolbarButton({
  name: "orderedList",
  label: "1. List",
  title: "Numbered list",
  group: "blocks",
  isActive: (ed: TiptapEditor) => ed.isActive("orderedList"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleOrderedList().run(),
});

registerToolbarButton({
  name: "blockquote",
  label: '" Quote',
  title: "Quote",
  group: "blocks",
  isActive: (ed: TiptapEditor) => ed.isActive("blockquote"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleBlockquote().run(),
});

registerToolbarButton({
  name: "codeBlock",
  label: "{ } Code",
  title: "Code block",
  group: "blocks",
  isActive: (ed: TiptapEditor) => ed.isActive("codeBlock"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleCodeBlock().run(),
});
