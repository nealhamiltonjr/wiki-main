import type { Editor as TiptapEditor } from "@tiptap/core";
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Code, CodeXml, Heading1, Heading2, Heading3,
  Highlighter, Italic, Link as LinkIcon, List, ListOrdered, ListTodo, MessageSquarePlus,
  Paperclip, Redo2, Search, TextQuote, Underline, Undo2,
  type LucideIcon,
} from "lucide-react";
import { getToolbarButtons } from "./pluginEngine.js";

/** B10: registered toolbar buttons are decoupled from icons (plugins pass text
 *  labels), so the chrome layer maps the well-known button names to lucide
 *  icons here. Anything unregistered falls back to its text label. */
const BUTTON_ICONS: Record<string, LucideIcon> = {
  bold: Bold,
  italic: Italic,
  underline: Underline,
  code: Code,
  link: LinkIcon,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
  bulletList: List,
  orderedList: ListOrdered,
  blockquote: TextQuote,
  codeBlock: CodeXml,
  taskList: ListTodo,
  highlight: Highlighter,
  alignLeft: AlignLeft,
  alignCenter: AlignCenter,
  alignRight: AlignRight,
};

export function Toolbar({ editor, onUploadFile, onAddComment, onSearch, showSearch = true, showComment = true }: {
  editor: TiptapEditor | null;
  onUploadFile: () => void;
  onAddComment: () => void;
  onSearch: () => void;
  /** Plugin-gated buttons (Search & Replace / Page Comments toggles). */
  showSearch?: boolean;
  showComment?: boolean;
}) {
  if (!editor) return null;

  const buttons = getToolbarButtons();
  const separator = <span className="wiki-toolbar-sep" />;

  // Group buttons by their group name, inserting separators between groups
  const groups: { name: string; buttons: typeof buttons }[] = [];
  for (const b of buttons) {
    const gname = b.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last.name === gname) {
      last.buttons.push(b);
    } else {
      groups.push({ name: gname, buttons: [b] });
    }
  }

  const toolBtn = (active: boolean, label: string, title: string, onClick: () => void, key: string, icon?: LucideIcon) => {
    const Icon = icon;
    return (
      <button
        key={key}
        type="button"
        className={`wiki-toolbar-btn${active ? " active" : ""}`}
        onClick={onClick}
        title={title}
        aria-label={title}
      >
        {Icon ? <Icon className="wiki-toolbar-icon" aria-hidden /> : label}
      </button>
    );
  };

  return (
    <div className="wiki-toolbar">
      {groups.map((group, gi) => (
        <span key={group.name} style={{ display: "contents" }}>
          {gi > 0 && separator}
          {group.buttons.map((b, bi) =>
            toolBtn(b.isActive(editor), b.label, b.title ?? b.label, () => b.onClick(editor), b.name ?? `${group.name}-${bi}`, BUTTON_ICONS[b.name])
          )}
        </span>
      ))}

      {separator}

      {showSearch && toolBtn(false, "Search", "Find & replace (Ctrl+F)", onSearch, "search", Search)}
      {showComment && toolBtn(false, "Comment", "Add comment on selection", onAddComment, "comment", MessageSquarePlus)}

      {separator}

      {toolBtn(false, "Upload", "Upload file (image → inline image, other → attachment link)", onUploadFile, "upload", Paperclip)}
      {toolBtn(false, "Undo", "Undo (Ctrl+Z)", () => editor.chain().focus().undo().run(), "undo", Undo2)}
      {toolBtn(false, "Redo", "Redo (Ctrl+Shift+Z)", () => editor.chain().focus().redo().run(), "redo", Redo2)}
    </div>
  );
}
