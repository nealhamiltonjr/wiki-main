import type { Editor as TiptapEditor } from "@tiptap/core";
import { getToolbarButtons } from "./pluginEngine.js";

export function Toolbar({ editor, onUploadImage, onAddComment }: { editor: TiptapEditor | null; onUploadImage: () => void; onAddComment: () => void }) {
  const btn = (active: boolean): React.CSSProperties => ({
    padding: "4px 8px",
    marginRight: 4,
    fontSize: 13,
    border: "1px solid #ccc",
    borderRadius: 4,
    background: active ? "#333" : "#fff",
    color: active ? "#fff" : "#333",
    cursor: "pointer",
  });

  if (!editor) return null;

  const buttons = getToolbarButtons();
  const separator = <span style={{ width: 1, background: "#ddd", margin: "0 4px" }} />;

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

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 2, padding: "6px 0", marginBottom: 8, borderBottom: "1px solid #eee" }}>
      {groups.map((group, gi) => (
        <span key={group.name} style={{ display: "contents" }}>
          {gi > 0 && separator}
          {group.buttons.map((b) => (
            <button
              key={b.name}
              type="button"
              style={btn(b.isActive(editor))}
              onClick={() => b.onClick(editor)}
              title={b.title}
            >
              {b.label}
            </button>
          ))}
        </span>
      ))}

      {separator}

      <button type="button" style={btn(false)} onClick={onAddComment} title="Add comment on selection">
        💬
      </button>

      {separator}

      <button type="button" style={btn(false)} onClick={onUploadImage} title="Insert image">
        🖼
      </button>
      <button type="button" style={btn(false)} onClick={() => editor.chain().focus().undo().run()} title="Undo (Ctrl+Z)">
        ↶
      </button>
      <button type="button" style={btn(false)} onClick={() => editor.chain().focus().redo().run()} title="Redo (Ctrl+Shift+Z)">
        ↷
      </button>
    </div>
  );
}
