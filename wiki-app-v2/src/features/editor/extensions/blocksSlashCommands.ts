import { registerSlashCommand } from "@/plugins/registry";

// ---------------------------------------------------------------------------
// First-party slash commands for the block-level content types that ship
// with StarterKit: headings, lists, blockquote, code block, divider.
//
// These live outside the plugin engine (same as Mermaid) because they're
// toggles of the schema every page is built with — they must work in any
// install, not only when a plugin is enabled.
//
// Loaded by registerCoreCommands() in src/plugins/coreCommands.ts, which is
// the single boot point. Do not call these directly from a route/component.
// ---------------------------------------------------------------------------

type Cmd = {
  name: string;
  label: string;
  icon: string;
  keywords: string[];
  run: (editor: import("@tiptap/core").Editor) => void;
};

const BLOCK_COMMANDS: Cmd[] = [
  {
    name: "heading-1",
    label: "Heading 1",
    icon: "H1",
    keywords: ["h1", "title", "header", "big"],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    name: "heading-2",
    label: "Heading 2",
    icon: "H2",
    keywords: ["h2", "subtitle", "header"],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    name: "heading-3",
    label: "Heading 3",
    icon: "H3",
    keywords: ["h3", "header", "small"],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    name: "heading-4",
    label: "Heading 4",
    icon: "H4",
    keywords: ["h4", "header"],
    run: (editor) => editor.chain().focus().toggleHeading({ level: 4 }).run(),
  },
  {
    name: "bullet-list",
    label: "Bullet list",
    icon: "•",
    keywords: ["ul", "unordered", "list", "bullets"],
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    name: "numbered-list",
    label: "Numbered list",
    icon: "1.",
    keywords: ["ol", "ordered", "list", "numbers"],
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    name: "quote",
    label: "Quote",
    icon: "❝",
    keywords: ["blockquote", "citation", "pull"],
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    name: "code",
    label: "Code block",
    icon: "</>",
    keywords: ["codeblock", "fence", "pre", "snippet"],
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    name: "divider",
    label: "Divider",
    icon: "—",
    keywords: ["separator", "hr", "line", "rule"],
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];

export function registerBlocksSlashCommands(): void {
  for (const cmd of BLOCK_COMMANDS) {
    try {
      registerSlashCommand(cmd);
    } catch (err) {
      // Same idempotency posture as registerMermaidSlashCommandIfNeeded in
      // coreCommands.ts: duplicate-name throws during hot-reload or in tests
      // are swallowed; first registration wins.
      if (!(err instanceof Error) || !/already registered/.test(err.message)) throw err;
    }
  }
}