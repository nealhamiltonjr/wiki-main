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
import { WikiLinkExtension } from "./wikiLinkExtension.js";
import type { Editor as TiptapEditor } from "@tiptap/core";

// ---------------------------------------------------------------------------
// Register Tiptap extensions
// ---------------------------------------------------------------------------
// MentionExtension is deliberately NOT registered here: it is a content-model
// node, so it lives in baseEditorExtensions() to keep the editor, the
// read-only ShareView, and the server's collab seed schema on the same schema
// (a page with a mention must parse in all three). Registering it here too
// would make the Editor load it twice ("duplicate extension names").
registerEditorExtension(SlashCommandExtension);
registerEditorExtension(WikiLinkExtension);

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
    searchTerms: [`h${level}`, "title", "section", "subtitle"],
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
  searchTerms: ["text", "p", "normal"],
  command: ({ editor }) => editor.chain().focus().setParagraph().run(),
});

registerSlashCommand({
  name: "blockquote",
  group: "Text",
  label: "Blockquote",
  icon: "❝",
  description: "Quoted text block",
  searchTerms: ["quote", "cite"],
  command: ({ editor }) => editor.chain().focus().toggleBlockquote().run(),
});

registerSlashCommand({
  name: "codeBlock",
  group: "Text",
  label: "Code block",
  icon: "</>",
  description: "Fenced code block with syntax highlighting",
  searchTerms: ["code", "fence", "pre", "preformatted"],
  command: ({ editor }) => editor.chain().focus().toggleCodeBlock().run(),
});

// Inline formatting (Siyuan/Docmost both surface these in the slash menu).
registerSlashCommand({
  name: "inlineCode",
  group: "Text",
  label: "Inline code",
  icon: "`",
  description: "Monospace code span",
  searchTerms: ["code", "monospace", "mono"],
  command: ({ editor }) => editor.chain().focus().toggleCode().run(),
});

registerSlashCommand({
  name: "bold",
  group: "Text",
  label: "Bold",
  icon: "B",
  description: "Bold text",
  searchTerms: ["strong", "emphasis"],
  command: ({ editor }) => editor.chain().focus().toggleBold().run(),
});

registerSlashCommand({
  name: "italic",
  group: "Text",
  label: "Italic",
  icon: "I",
  description: "Italic text",
  searchTerms: ["em", "emphasis", "slanted"],
  command: ({ editor }) => editor.chain().focus().toggleItalic().run(),
});

registerSlashCommand({
  name: "underline",
  group: "Text",
  label: "Underline",
  icon: "U",
  description: "Underlined text",
  searchTerms: ["underscore"],
  command: ({ editor }) => editor.chain().focus().toggleUnderline().run(),
});

registerSlashCommand({
  name: "strikethrough",
  group: "Text",
  label: "Strikethrough",
  icon: "S̶",
  description: "Struck-through text",
  searchTerms: ["strike", "del", "deleted"],
  command: ({ editor }) => editor.chain().focus().toggleStrike().run(),
});

registerSlashCommand({
  name: "link",
  group: "Text",
  label: "Link",
  icon: "🔗",
  description: "Insert a hyperlink",
  searchTerms: ["url", "href", "hyperlink"],
  command: ({ editor }) => {
    const href = window.prompt("URL:");
    if (href) editor.chain().focus().setLink({ href }).run();
  },
});

registerSlashCommand({
  name: "bulletList",
  group: "Lists",
  label: "Bullet list",
  icon: "•",
  description: "Unordered list",
  searchTerms: ["ul", "unordered", "list"],
  command: ({ editor }) => editor.chain().focus().toggleBulletList().run(),
});

registerSlashCommand({
  name: "orderedList",
  group: "Lists",
  label: "Numbered list",
  icon: "1.",
  description: "Ordered list",
  searchTerms: ["ol", "ordered", "list"],
  command: ({ editor }) => editor.chain().focus().toggleOrderedList().run(),
});

registerSlashCommand({
  name: "taskList",
  group: "Lists",
  label: "Task list",
  icon: "☑",
  description: "Checklist with interactive boxes",
  searchTerms: ["checkbox", "todo", "to-do", "checklist"],
  command: ({ editor }) => editor.chain().focus().toggleTaskList().run(),
});

registerSlashCommand({
  name: "horizontalRule",
  group: "Content",
  label: "Divider",
  icon: "—",
  description: "Horizontal rule / separator line",
  searchTerms: ["hr", "separator", "line", "rule"],
  command: ({ editor }) => editor.chain().focus().setHorizontalRule().run(),
});

registerSlashCommand({
  name: "image",
  group: "Content",
  label: "Image",
  icon: "🖼",
  description: "Insert an image by URL",
  searchTerms: ["img", "picture", "photo", "image"],
  command: ({ editor }) => {
    const src = window.prompt("Image URL:");
    if (src) editor.chain().focus().setImage({ src }).run();
  },
});

// Uploads go through the Editor's hidden file input (same handler as the
// toolbar button): images become clean standalone images, other files become
// attachment blocks. The editor listens for this window event.
registerSlashCommand({
  name: "uploadFile",
  group: "Content",
  label: "Upload file",
  icon: "📎",
  description: "Upload an image or file from your computer",
  searchTerms: ["attachment", "file", "upload", "attach", "video"],
  command: () => {
    window.dispatchEvent(new CustomEvent("wiki-upload-request"));
  },
});

registerSlashCommand({
  name: "highlight",
  group: "Text",
  label: "Highlight",
  icon: "🖍",
  description: "Mark text with a highlight color",
  searchTerms: ["mark", "color", "pen"],
  command: ({ editor }) => editor.chain().focus().toggleHighlight({ color: "#ffe58f" }).run(),
});

registerSlashCommand({
  name: "alignLeft",
  group: "Alignment",
  label: "Align left",
  icon: "⇤",
  description: "Left-align the block",
  searchTerms: ["left", "justify"],
  command: ({ editor }) => editor.chain().focus().setTextAlign("left").run(),
});

registerSlashCommand({
  name: "alignCenter",
  group: "Alignment",
  label: "Align center",
  icon: "⇔",
  description: "Center the block",
  searchTerms: ["center", "centre"],
  command: ({ editor }) => editor.chain().focus().setTextAlign("center").run(),
});

registerSlashCommand({
  name: "alignRight",
  group: "Alignment",
  label: "Align right",
  icon: "⇥",
  description: "Right-align the block",
  searchTerms: ["right", "justify"],
  command: ({ editor }) => editor.chain().focus().setTextAlign("right").run(),
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

registerToolbarButton({
  name: "taskList",
  label: "☑ Task",
  title: "Task list",
  group: "blocks",
  isActive: (ed: TiptapEditor) => ed.isActive("taskList"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleTaskList().run(),
});

registerToolbarButton({
  name: "highlight",
  label: "🖍 Highlight",
  title: "Highlight",
  group: "marks",
  isActive: (ed: TiptapEditor) => ed.isActive("highlight"),
  onClick: (ed: TiptapEditor) => ed.chain().focus().toggleHighlight({ color: "#ffe58f" }).run(),
});

registerToolbarButton({
  name: "alignLeft",
  label: "⇤",
  title: "Align left",
  group: "align",
  isActive: (ed: TiptapEditor) => ed.isActive({ textAlign: "left" }),
  onClick: (ed: TiptapEditor) => ed.chain().focus().setTextAlign("left").run(),
});

registerToolbarButton({
  name: "alignCenter",
  label: "⇔",
  title: "Align center",
  group: "align",
  isActive: (ed: TiptapEditor) => ed.isActive({ textAlign: "center" }),
  onClick: (ed: TiptapEditor) => ed.chain().focus().setTextAlign("center").run(),
});

registerToolbarButton({
  name: "alignRight",
  label: "⇥",
  title: "Align right",
  group: "align",
  isActive: (ed: TiptapEditor) => ed.isActive({ textAlign: "right" }),
  onClick: (ed: TiptapEditor) => ed.chain().focus().setTextAlign("right").run(),
});
