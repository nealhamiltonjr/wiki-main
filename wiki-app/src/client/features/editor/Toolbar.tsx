import type { Editor as TiptapEditor } from "@tiptap/core";
import { getToolbarButtons } from "./pluginEngine.js";

export function Toolbar({ editor, onUploadImage, onAddComment, onSearch }: { editor: TiptapEditor | null; onUploadImage: () => void; onAddComment: () => void; onSearch: () => void }) {
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

  const toolBtn = (active: boolean, label: string, title: string, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      className={`wiki-toolbar-btn${active ? " active" : ""}`}
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div className="wiki-toolbar">
      {groups.map((group, gi) => (
        <span key={group.name} style={{ display: "contents" }}>
          {gi > 0 && separator}
          {group.buttons.map((b, bi) =>
            toolBtn(b.isActive(editor), b.label, b.title ?? b.label, () => b.onClick(editor), b.name ?? `${group.name}-${bi}`)
          )}
        </span>
      ))}

      {separator}

      {toolBtn(false, "🔍", "Find & replace (Ctrl+F)", onSearch, "search")}
      {toolBtn(false, "💬", "Add comment on selection", onAddComment, "comment")}

      {separator}

      {toolBtn(false, "🖼", "Insert image", onUploadImage, "image")}
      {toolBtn(false, "↶", "Undo (Ctrl+Z)", () => editor.chain().focus().undo().run(), "undo")}
      {toolBtn(false, "↷", "Redo (Ctrl+Shift+Z)", () => editor.chain().focus().redo().run(), "redo")}
    </div>
  );
}
